'use strict'

/**
 * 移动端 README 截图工具
 *
 * 用 Electron（Chromium，与安卓 WebView 同内核）以手机视口加载
 * mobile/www/index.html（store.js + bridge.js + app.js + mobile-ui.js，无 preload），
 * 把 tools/demo-dataset.js 这份演示数据灌进去，然后截两张图：
 *
 *   docs/screenshots/mobile-tasks.png  手机端任务列表（今日任务视图）
 *   docs/screenshots/mobile-sync.png   手机端设置面板，滚动到「电脑地址 / 立即与电脑同步」
 *
 * 用法（在仓库根目录）：npx electron tools/screenshots-mobile.js
 *
 * 窗口 390×844；本机缩放是 125%，所以截图是 472×978 像素（见报告里的 dpr）。
 *
 * 幂等：每次先 localStorage.clear() 再 reload，所以重复运行结果一致，不会重复插任务。
 */

const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const crypto = require('node:crypto')

const demo = require('./demo-dataset')

// 必须在 app.whenReady() 之前设置：别把演示数据写进用户真实的 userData 目录
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'xinghelu-mobile-shots-')))
// 无头环境里硬件加速常导致 capturePage 拿到黑屏/空白
app.disableHardwareAcceleration()

const OUT_DIR = path.join(__dirname, '..', 'docs', 'screenshots')
const SHOTS = {
  tasks: path.join(OUT_DIR, 'mobile-tasks.png'),
  sync: path.join(OUT_DIR, 'mobile-sync.png'),
}

const W = 390
const H = 844

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function poll(fn, timeout = 15000, step = 120, label = '条件') {
  const deadline = Date.now() + timeout
  let last = null
  while (Date.now() < deadline) {
    try {
      last = await fn()
    } catch (_) {
      last = null
    }
    if (last) return last
    await sleep(step)
  }
  throw new Error(`等待超时：${label}（最后一次结果 ${JSON.stringify(last)}）`)
}

/* ------------------------------------------------------------------ *
 * 灌演示数据
 * ------------------------------------------------------------------ */

// demo-dataset 的可读写法 → app.js/store.js 实际使用的字段
const PRIORITY = { normal: 0, important: 1, urgent: 2 }

/** 在页面里跑：把上一轮的演示数据清掉，然后 reload 让 store 从干净的 localStorage 重建 */
function seedScript() {
  return `(async () => {
    // 清空上一轮：不做这一步，第二次运行会把任务再插一遍
    try { localStorage.clear() } catch (e) {}
    location.reload()
    return true
  })()`
}

/** reload 之后再跑：此时 store/bridge 已加载，localStorage 已是干净的 */
function fillScript(dataset, priorityMap) {
  return `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const U = window.XingheUtils
    const api = window.memoApi
    const dataset = ${JSON.stringify(dataset)}
    const PRIORITY = ${JSON.stringify(priorityMap)}

    // 今天必须由 store 自己的助手算，不在宿主机硬编码日期
    const boot = await api.bootstrap({})
    const today = boot.today

    // 关掉顺延：不然昨天两条未完成会被搬到今天，任务列表就和桌面端截图对不上了
    await api.saveSettings(dataset.settings)
    await api.saveSettings({ carryOver: false, syncServer: '' })

    let tasks = 0
    let memos = 0
    for (const spec of dataset.tasks) {
      const key = U.shiftKey(today, Number(spec.day) || 0)
      const r = await api.addTask({
        date: key,
        title: spec.title,
        note: spec.note || '',
        priority: PRIORITY[spec.priority] != null ? PRIORITY[spec.priority] : 0,
        type: spec.type || 'none',
        remindAt: spec.remindTime || null,
        repeat: spec.repeat || 'none',
      })
      if (spec.done) await api.toggleTask(r.task.id)
      tasks++
    }

    for (const [dayOffset, text] of Object.entries(dataset.memos || {})) {
      await api.setMemo({ date: U.shiftKey(today, Number(dayOffset) || 0), text })
      memos++
    }

    // 最后回到今天并重画；顺延已关闭，这一步不会改动任务分布
    const payload = await api.loadDate({ date: today })
    await sleep(150)

    return {
      today,
      tasks,
      memos,
      todayTasks: payload.tasks.length,
      doneToday: payload.tasks.filter((t) => t.done).length,
      doneTitles: payload.tasks.filter((t) => t.done).map((t) => t.title),
      titles: payload.tasks.map((t) => t.title),
      memoChars: (payload.memo && payload.memo.text || '').length,
      carryOver: (await api.syncStatus()).tasks,
    }
  })()`
}

/* ------------------------------------------------------------------ *
 * 截图前的稳定条件 + 自己核对一遍画面内容
 * ------------------------------------------------------------------ */

/**
 * 页面内的通用助手：等动画/过渡全部停下来，并且所有选择器都真的完全不透明。
 * 这一段会被拼进下面几个脚本里。item-in（先透明再淡入）和 m-sheet-in（抽屉上滑）
 * 都是 CSS 动画，所以要两件事一起等：动画队列空了 + 计算样式 opacity 已经是 1。
 */
const PAGE_HELPERS = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const running = () => (document.getAnimations ? document.getAnimations() : []).filter((a) => a.playState === 'running')
  const describe = (a) => {
    try {
      const t = a.effect && a.effect.target
      return (a.animationName || a.transitionProperty || 'anim') + '@' + (t ? t.tagName + '.' + String(t.className || '') : '?')
    } catch (e) { return 'anim' }
  }
  const allOpaque = (sel) => {
    const nodes = [...document.querySelectorAll(sel)]
    if (!nodes.length) return false
    return nodes.every((n) => getComputedStyle(n).opacity === '1')
  }
  async function settled(sels, timeout) {
    const deadline = Date.now() + (timeout || 8000)
    let runningNames = []
    let faded = []
    while (Date.now() < deadline) {
      faded = sels.filter((s) => !allOpaque(s))
      runningNames = running().map(describe)
      if (!faded.length && !runningNames.length) return { ok: true, faded: [], running: [] }
      await sleep(50)
    }
    return { ok: false, faded, running: runningNames }
  }
`

/** 等任务列表画好、动画停稳、每张卡片都不透明；顺便把顶栏滚到最上面 */
const prepareTasksScript = `(async () => {
  const $ = (id) => document.getElementById(id)
  ${PAGE_HELPERS}
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (window.__memoReady && window.__memoReady.hasApi && document.querySelectorAll('#taskList .task-item').length >= 5) break
    await sleep(100)
  }
  $('taskList').closest('.m-tasks').scrollTop = 0
  const st = await settled(['#taskList .task-item'], 10000)
  const settledInfo = st.ok ? null : { why: '任务卡片没停稳', ...st }
  const items = [...document.querySelectorAll('#taskList .task-item')].map((li) => {
    const title = li.querySelector('.task-title')
    const cs = getComputedStyle(li)
    const tcs = title ? getComputedStyle(title) : null
    return {
      title: title ? title.textContent : '',
      opacity: Number(cs.opacity),
      animation: cs.animationName,
      animationPlayState: cs.animationPlayState,
      animationDuration: cs.animationDuration,
      titleOpacity: title ? Number(tcs.opacity) : null,
      anims: (document.getAnimations ? document.getAnimations() : [])
        .filter((a) => a.effect && a.effect.target === li)
        .map((a) => ({ name: a.animationName || a.transitionProperty, state: a.playState })),
    }
  })
  // 稳定 = 每张卡片都完全不透明，而且没有任何动画还在 running
  const faded = items.filter((it) => it.opacity !== 1 || it.titleOpacity !== 1)
  const stillAnimating = items.filter((it) => it.animationPlayState === 'running' && it.animation !== 'none')
  return {
    ok: !faded.length && !stillAnimating.length,
    rows: items.length,
    items,
    unfaded: faded.length,
    stillAnimating: stillAnimating.length,
    totalAnims: (document.getAnimations ? document.getAnimations() : []).length,
    stillRunning: running().length,
    settledInfo,
    listScrollTop: Math.round($('taskList').closest('.m-tasks').scrollTop),
  }
})()`

const auditTasksScript = `(() => {
  const $ = (id) => document.getElementById(id)
  const r = (n) => { const b = n.getBoundingClientRect(); return { t: Math.round(b.top), b: Math.round(b.bottom), l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height) } }
  const dt = $('dateTitle')
  const rows = [...document.querySelectorAll('#taskList .task-item')].map((li) => ({
    title: li.querySelector('.task-title') ? li.querySelector('.task-title').textContent : '',
    done: li.classList.contains('is-done'),
    badges: [...li.querySelectorAll('.task-badges .badge')].map((b) => b.textContent),
    rect: r(li),
    visible: r(li).t >= 0 && r(li).b <= window.innerHeight,
  }))
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    dateTitle: dt.textContent,
    dateSub: $('dateSub').textContent,
    dateTruncated: dt.scrollWidth > dt.clientWidth + 1,
    rows,
    toastVisible: !$('toast').hidden,
    modalHidden: getComputedStyle($('settingsModal')).display === 'none',
    sheetOpen: !$('sheetComposer').hidden || !$('sheetMemo').hidden || !$('sheetCalendar').hidden,
  }
})()`

/** 像用户那样打开设置：点顶栏齿轮，然后等抽屉滑入动画结束、卡片完全不透明 */
const openSettingsScript = `(async () => {
  const $ = (id) => document.getElementById(id)
  ${PAGE_HELPERS}
  $('settingsBtn').click()
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && getComputedStyle($('settingsModal')).display === 'none') await sleep(50)
  const st = await settled(['#settingsModal .modal-card'], 10000)
  if (!st.ok) return { failed: true, why: '设置面板没停稳', ...st }
  const card = document.querySelector('#settingsModal .modal-card')
  return { ok: true, display: getComputedStyle($('settingsModal')).display, cardOpacity: getComputedStyle(card).opacity, cardTop: Math.round(card.getBoundingClientRect().top) }
})()`

/**
 * 滚动设置面板，让「电脑地址」输入框与「立即与电脑同步」按钮都完整可见。
 * 移动端真正滚动的是 #settingsModal 这一层（.modal-card 被限高 88vh），
 * 直接 scrollIntoView 会被外层容器抢走滚动量，所以这里显式分两步滚：
 * 先滚 .modal-body 把输入框送到上部，再滚弹窗层把同步按钮底部拉进视口。
 */
const scrollToSyncScript = `(async () => {
  const $ = (id) => document.getElementById(id)
  ${PAGE_HELPERS}
  const modal = $('settingsModal')
  const body = modal.querySelector('.modal-body')
  const input = $('syncServerInput')
  const btn = $('syncNowBtn')
  const row = input.closest('.row')

  modal.scrollTop = 0
  body.scrollTop = 0
  await sleep(120)

  input.scrollIntoView({ block: 'center' }) // 用户能看到「电脑地址」那一行
  await sleep(80)
  const desired = Math.round(window.innerHeight * 0.12)
  body.scrollTop = Math.max(0, body.scrollTop + Math.round(row.getBoundingClientRect().top - body.getBoundingClientRect().top - desired))
  await sleep(80)

  const need = Math.round(btn.getBoundingClientRect().bottom - window.innerHeight + 20)
  if (need > 0) modal.scrollTop = Math.min(need, modal.scrollHeight - modal.clientHeight)
  await sleep(120)

  const st = await settled(['#settingsModal .modal-card'], 6000)
  const ib = input.getBoundingClientRect()
  const bb = btn.getBoundingClientRect()
  const hb = modal.querySelector('.modal-head').getBoundingClientRect()
  return {
    settled: st.ok,
    running: st.running,
    modalScrollTop: Math.round(modal.scrollTop),
    bodyScrollTop: Math.round(body.scrollTop),
    inputInView: ib.top >= hb.bottom && ib.bottom <= window.innerHeight,
    buttonInView: bb.top >= hb.bottom && bb.bottom <= window.innerHeight,
  }
})()`

const auditSyncScript = `(() => {
  const $ = (id) => document.getElementById(id)
  const r = (n) => { const b = n.getBoundingClientRect(); return { t: Math.round(b.top), b: Math.round(b.bottom), l: Math.round(b.left), w: Math.round(b.width), h: Math.round(b.height) } }
  const input = $('syncServerInput')
  const btn = $('syncNowBtn')
  const row = input.closest('.row')
  const card = document.querySelector('#settingsModal .modal-card')
  const head = document.querySelector('#settingsModal .modal-head')
  const hint = card.querySelector('.hint')
  const ib = r(input)
  const bb = r(btn)
  const hb = r(head)
  const inView = (b) => b.t >= hb.b && b.b <= window.innerHeight
  const addBtn = document.querySelector('.m-add-btn')
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    modalDisplay: getComputedStyle($('settingsModal')).display,
    cardOpacity: getComputedStyle(card).opacity,
    cardAnimation: getComputedStyle(card).animationName,
    cardAnimationPlayState: getComputedStyle(card).animationPlayState,
    stillRunning: (document.getAnimations ? document.getAnimations() : []).filter((a) => a.playState === 'running').length,
    rowLabel: row ? row.querySelector('span').textContent : '',
    inputRect: ib,
    inputValue: input.value,
    inputPlaceholder: input.placeholder,
    btnText: btn.textContent,
    btnDisabled: btn.disabled,
    btnRect: bb,
    inputVisible: inView(ib),
    btnVisible: inView(bb),
    gapBetween: bb.t - ib.b,
    modalHeadBottom: hb.b,
    cardRect: r(card),
    modalScrollTop: Math.round($('settingsModal').scrollTop),
    modalScrollable: $('settingsModal').scrollHeight > $('settingsModal').clientHeight + 1,
    bodyScrollTop: Math.round(card.querySelector('.modal-body').scrollTop),
    addBtnRect: addBtn ? r(addBtn) : null,
    hintText: (hint ? hint.textContent : '').replace(/\\s+/g, ' ').trim().slice(0, 60),
    syncStatusText: ($('syncStatusText') || {}).textContent,
    desktopOnlyHidden: [...document.querySelectorAll('#settingsModal [data-desktop-only]')].every(
      (n) => getComputedStyle(n).display === 'none'
    ),
    toastVisible: !$('toast').hidden,
  }
})()`

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  if (!demo || !Array.isArray(demo.tasks) || !demo.tasks.length) {
    throw new Error('tools/demo-dataset.js 没有导出可用的 tasks')
  }
  fs.mkdirSync(OUT_DIR, { recursive: true })

  const errors = []
  await app.whenReady()

  const win = new BrowserWindow({
    width: W,
    height: H,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 窗口不在前台时渲染进程会被降频，动画可能一直停在半路
      backgroundThrottling: false,
    },
  })
  win.webContents.on('console-message', (...args) => {
    const ev = args[0]
    if (ev && typeof ev === 'object' && typeof ev.message === 'string') {
      if (ev.level === 'error') errors.push(`error: ${ev.message}`)
    }
  })
  win.webContents.on('did-fail-load', (_e, code, desc) => errors.push(`did-fail-load ${code} ${desc}`))

  const indexHtml = path.join(__dirname, '..', 'mobile', 'www', 'index.html')
  let settleCssKey = null
  const neutraliseMotion = async () => {
    settleCssKey = await win.webContents.insertCSS(FORCE_SETTLED_CSS)
  }

  // 第一遍：清库
  await win.loadFile(indexHtml)
  await neutraliseMotion()
  await poll(
    async () => await win.webContents.executeJavaScript('!!(window.memoApi && window.XingheUtils)'),
    15000,
    100,
    'bridge 就绪'
  )
  await win.webContents.executeJavaScript(seedScript())
  await poll(
    async () => {
      const done = await win.webContents.executeJavaScript('document.readyState === "complete" && !!(window.memoApi && window.XingheUtils)')
      if (!done) return null
      const n = await win.webContents.executeJavaScript("document.querySelectorAll('#taskList .task-item').length")
      return n === 0 ? { n } : null
    },
    20000,
    150,
    '清库后重新加载完成'
  )

  // 第二遍：灌演示数据（只通过 window.memoApi.*，不直接改内存）
  const seeded = await win.webContents.executeJavaScript(fillScript(demo, PRIORITY))

  // 第三遍：重新加载。app.js 只在 bootstrap 时把数据搬进界面状态，
  // 所以灌完数据必须让界面自己重新 bootstrap 一次（等价于用户重开应用）。
  await win.loadFile(indexHtml)
  await neutraliseMotion()
  await poll(
    async () =>
      (await win.webContents.executeJavaScript('window.__memoReady && window.__memoReady.hasApi')) ? true : null,
    20000,
    150,
    '界面 ready'
  )
  // 顺延已关闭，bootstrap 不会改动任务分布；这里再确认一次今天仍有 7 条
  const afterBoot = await win.webContents.executeJavaScript(
    `(async () => { const d = await window.memoApi.loadDate({ date: window.__memoReady.date }); return { date: d.date, tasks: d.tasks.length } })()`
  )

  /* ---------- 第一张：任务列表 ---------- */
  let prepared = null
  let auditTasks = null
  let shot1 = null
  let reminderQuiet = null
  for (let attempt = 1; attempt <= 3 && !shot1; attempt++) {
    prepared = await win.webContents.executeJavaScript(prepareTasksScript)
    if (!prepared || !prepared.ok || prepared.stillRunning !== 0) {
      process.stdout.write(`\n[任务列表第 ${attempt} 次准备未停稳] ${JSON.stringify(prepared)}\n`)
      await sleep(700)
      continue
    }
    // 界面已经画好了，再关掉到点提醒：截图进程不该被「任务提醒」toast 盖住内容
    reminderQuiet = await win.webContents.executeJavaScript(
      `window.memoApi.saveSettings({ reminderEnabled: false }).then((s) => s.reminderEnabled)`
    )
    auditTasks = await win.webContents.executeJavaScript(auditTasksScript)
    // 先断言状态：卡片全不透明、动画停完，否则绝不写文件
    assertTasksReady(prepared, auditTasks)
    shot1 = await capture(win, SHOTS.tasks, {
      // 任务行所在区域（CSS 像素）：必须有清晰的深色文字，且完全没有半透明像素
      regions: [[24, 250, 352, 700]],
      minInk: 0.03,
      minDark: 0.008,
      minAlpha: 0.7,
    })
  }
  if (!shot1) throw new Error('任务列表截图始终没停稳：' + JSON.stringify(prepared))

  /* ---------- 第二张：设置里的同步区 ---------- */
  const opened = await win.webContents.executeJavaScript(openSettingsScript)
  if (!opened || !opened.ok) throw new Error('设置面板没有打开/没停稳：' + JSON.stringify(opened))
  let scrolled = null
  let auditSync = null
  let shot2 = null
  for (let attempt = 1; attempt <= 3 && !shot2; attempt++) {
    scrolled = await win.webContents.executeJavaScript(scrollToSyncScript)
    auditSync = await win.webContents.executeJavaScript(auditSyncScript)
    if (!scrolled.inputInView || !scrolled.buttonInView || !scrolled.settled) {
      process.stdout.write(`\n[同步区第 ${attempt} 次定位未达标] ${JSON.stringify(scrolled)}\n`)
      await sleep(500)
      continue
    }
    // 断言要拍的内容真的在视口里、且面板已完全展开
    assertSyncReady(auditSync)
    shot2 = await capture(win, SHOTS.sync, {
      regions: [
        // 「电脑地址」那一行 + 「立即与电脑同步」按钮
        [16, Math.max(0, auditSync.inputRect.t - 18), 362, Math.min(782, auditSync.btnRect.b + 8)],
        // 面板头部「设置」标题
        [16, Math.max(0, auditSync.cardRect.t + 8), 362, Math.max(60, auditSync.modalHeadBottom + 6)],
        // 底部操作栏被面板盖住的位置：这里必须"没有墨"，否则说明面板还滑在半路
        [
          16,
          Math.max(0, (auditSync.addBtnRect ? auditSync.addBtnRect.t : 740) - 4),
          362,
          Math.min(782, (auditSync.addBtnRect ? auditSync.addBtnRect.b : 782) + 4),
        ],
      ],
      minInk: 0.02,
      minDark: 0.004,
      minAlpha: 0.7,
      maxRegionInk: [2, 0.008],
    })
  }
  if (!shot2) throw new Error('同步区定位/停稳失败：' + JSON.stringify({ scrolled, auditSync }))

  /* ---------- 自检 ---------- */
  const problems = []
  const check = (name, cond, detail) => {
    if (!cond) problems.push(`${name}：${detail}`)
  }

  check('视口是手机尺寸', auditTasks.innerWidth <= 420, `${auditTasks.innerWidth}px`)
  check('任务行数 >= 5', auditTasks.rows.length >= 5, `${auditTasks.rows.length} 行`)
  check('日期标题未截断', !auditTasks.dateTruncated, `"${auditTasks.dateTitle}"`)
  check(
    '有勾选态任务',
    auditTasks.rows.some((r) => r.done),
    `done=${auditTasks.rows.filter((r) => r.done).length}`
  )
  check(
    '有优先级/类型徽章',
    auditTasks.rows.some((r) => r.badges.some((b) => /普通|重要|紧急|工作|私人|重复|顺延自/.test(b))),
    JSON.stringify(auditTasks.rows.map((r) => r.badges))
  )
  check('任务截图没有 toast 遮挡', !auditTasks.toastVisible, 'toast 可见')
  check('任务截图没有抽屉打开', !auditTasks.sheetOpen && auditTasks.modalHidden, '有面板打开')
  check(
    '任务卡片全部完全不透明 + 动画已停',
    prepared.items.every((it) => it.opacity === '1' && it.titleOpacity === '1') && prepared.stillRunning === 0,
    `opacity=${prepared.items.map((it) => it.opacity).join(',')} 运行中动画=${prepared.stillRunning}`
  )

  check('设置面板已展开', auditSync.modalDisplay !== 'none', auditSync.modalDisplay)
  check('设置面板卡片完全不透明 + 动画已停', auditSync.cardOpacity === '1' && auditSync.stillRunning === 0, `opacity=${auditSync.cardOpacity} 运行中=${auditSync.stillRunning}`)
  check('电脑地址输入框在视口内', auditSync.inputVisible, JSON.stringify(auditSync.inputRect))
  check('「立即与电脑同步」按钮在视口内', auditSync.btnVisible, JSON.stringify(auditSync.btnRect))
  check('按钮文案正确', auditSync.btnText.indexOf('同步') >= 0, auditSync.btnText)
  check('同步截图没有 toast 遮挡', !auditSync.toastVisible, 'toast 可见')
  check('截图不是空白', shot1.bytes > 5000 && shot2.bytes > 5000, `${shot1.bytes} / ${shot2.bytes} 字节`)
  check(
    '任务列表真的画出来了（不是半渲染帧）',
    Math.min(...shot1.inks) >= 0.03 && Math.min(...shot1.darkInks) >= 0.008,
    `淡墨迹=${shot1.inks.join('/')} 实墨迹=${shot1.darkInks.join('/')}`
  )
  check(
    '同步区真的画出来了（不是半渲染帧）',
    Math.min(...shot2.inks) >= 0.02 && Math.min(...shot2.darkInks) >= 0.004,
    `淡墨迹=${shot2.inks.join('/')} 实墨迹=${shot2.darkInks.join('/')}`
  )
  check(
    '底部操作栏已被面板完全盖住（不是滑到一半）',
    shot2.maxInks[2] <= 0.008 && Math.min(...shot2.alphas) >= 0.7,
    `操作栏区域墨迹=${shot2.maxInks[2]} 最小不透明度=${Math.min(...shot2.alphas).toFixed(3)}`
  )
  check(
    '截图是竖屏手机形状',
    shot1.width / shot1.height < 0.75 && shot2.width / shot2.height < 0.75,
    `${shot1.width}x${shot1.height} / ${shot2.width}x${shot2.height}`
  )

  const report = {
    ok: problems.length === 0,
    outputs: [
      { file: SHOTS.tasks, ...shot1 },
      { file: SHOTS.sync, ...shot2 },
    ],
    seeded,
    afterBoot,
    reminderDisabledAfterPaint: reminderQuiet,
    tasksPrepared: prepared,
    syncScrolled: scrolled,
    taskAudit: auditTasks,
    syncAudit: auditSync,
    consoleErrors: errors,
    problems,
    electron: process.versions.electron,
  }
  process.stdout.write('\n===== MOBILE SCREENSHOTS =====\n' + JSON.stringify(report, null, 2) + '\n==============================\n')

  win.destroy()
  app.exit(problems.length === 0 ? 0 : 1)
}

/* ------------------------------------------------------------------ *
 * 极简 PNG 解码：只用来核对截图里到底画没画出内容。
 * capturePage 在无头窗口上会返回过期帧（列表空白 / 设置面板缺失），
 * 所以每张图都要自己数一遍"墨迹"，不合格就重画重截。
 * ------------------------------------------------------------------ */

const zlib = require('node:zlib')

let CRC_TABLE = null
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[i] = c
    }
  }
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const paeth = (a, b, c) => {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** PNG → { width, height, ink(x0,y0,x1,y1) }，坐标为图像像素 */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG')
  let i = 8
  let width = 0
  let height = 0
  let channels = 0
  const idat = []
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i)
    const type = buf.toString('ascii', i + 4, i + 8)
    const data = buf.subarray(i + 8, i + 8 + len)
    if (crc32(buf.subarray(i + 4, i + 8 + len)) !== buf.readUInt32BE(i + 8 + len)) {
      throw new Error(`PNG 分块校验失败：${type}`)
    }
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const depth = data[8]
      const colorType = data[9]
      const interlace = data[12]
      if (depth !== 8) throw new Error(`只支持 8 位灰度/RGB/RGBA，收到 ${depth} 位`)
      if (interlace !== 0) throw new Error('不支持隔行 PNG')
      channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0
      if (!channels) throw new Error(`不支持的颜色类型 ${colorType}`)
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    i += 12 + len
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(stride * height)
  let pos = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]
    const line = raw.subarray(pos, pos + stride)
    pos += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= channels ? prev[x - channels] : 0
      const v = line[x]
      cur[x] = filter === 0 ? v : filter === 1 ? (v + a) & 0xff : filter === 2 ? (v + b) & 0xff : filter === 3 ? (v + ((a + b) >> 1)) & 0xff : (v + paeth(a, b, c)) & 0xff
    }
  }

  const gray = (x, y) => {
    const o = y * stride + x * channels
    if (channels === 4) return Math.round(0.299 * out[o] + 0.587 * out[o + 1] + 0.114 * out[o + 2])
    if (channels === 3) return Math.round(0.299 * out[o] + 0.587 * out[o + 1] + 0.114 * out[o + 2])
    return out[o]
  }

  /** 区域内"明显比该区域背景暗"的像素占比 —— 文字/图标/描边越多，值越大 */
  const ink = (r, threshold = 40) => {
    const x0 = Math.max(0, Math.round(r[0]))
    const y0 = Math.max(0, Math.round(r[1]))
    const x1 = Math.min(width, Math.round(r[2]))
    const y1 = Math.min(height, Math.round(r[3]))
    const n = (x1 - x0) * (y1 - y0)
    if (n <= 0) return 0
    // 先估区域内最亮的背景（用直方图 95 分位）
    const hist = new Uint32Array(256)
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) hist[gray(x, y)]++
    let acc = 0
    let bg = 255
    for (let v = 255; v >= 0; v--) {
      acc += hist[v]
      if (acc >= n * 0.05) {
        bg = v
        break
      }
    }
    let dark = 0
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (gray(x, y) < bg - threshold) dark++
    return dark / n
  }

  /**
   * 区域里"很黑的像素"（文字主体的深色笔画）占比。
   * 半渲染/幽灵帧只有浅灰的整块色，这里会接近 0 —— 这是区分"画全了"和
   * "画了一半"最可靠的指标。
   */
  const darkInk = (r) => ink(r, 130)

  /**
   * 区域内"没有完全不透明"的像素占比（alpha < 180，按 0–255 计）。
   * 卡片淡入到一半、面板滑到一半时，画面里一定会留下大量半透明像素，
   * 所以这个值必须接近 0，才说明拍到的是稳定态而不是过渡帧。
   */
  const alphaInk = (r) => {
    if (channels !== 4) return 0
    const x0 = Math.max(0, Math.round(r[0]))
    const y0 = Math.max(0, Math.round(r[1]))
    const x1 = Math.min(width, Math.round(r[2]))
    const y1 = Math.min(height, Math.round(r[3]))
    const n = (x1 - x0) * (y1 - y0)
    if (n <= 0) return 0
    let semi = 0
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) if (out[y * stride + x * channels + 3] < 180) semi++
    }
    return semi / n
  }

  return { width, height, channels, gray, ink, darkInk, alphaInk }
}

/**
 * 截图前把入场动画/过渡关掉（一次性注入，只在这次截图加载里生效）。
 *
 * 为什么必须这么做：本机 Electron 44 里 CSS 动画的播放时钟不推进，
 * item-in（opacity 0 → 1）会把最后两张卡片永久卡在 opacity 0.58，
 * 而且 document.getAnimations() 对 CSS 动画返回空数组、animationPlayState 一直是
 * running —— 也就是说"等动画结束"这条路走不通，光等永远等不到。
 * 所以按兜底方案把动画整个取消（不是只把时长清零：实测清零后那两张仍然卡住），
 * 动画取消后元素直接使用样式表里的终态（opacity:1、无位移），拍到的就是稳定帧。
 */
const FORCE_SETTLED_CSS =
  '*,*::before,*::after{animation:none !important;transition:none !important}'

/* ------------------------------------------------------------------ *
 * 写文件前的状态断言：不符合就直接抛，绝不写下没核对过的图
 * ------------------------------------------------------------------ */

function assertTasksReady(prep, audit) {
  if (!prep || !prep.ok) throw new Error('任务列表没有就绪：' + JSON.stringify(prep))
  if (prep.stillAnimating !== 0) throw new Error('任务卡片还有动画在跑：' + prep.stillAnimating)
  if (prep.rows < 5) throw new Error('任务行数不足：' + prep.rows)
  const faded = prep.items.filter((it) => it.opacity !== 1 || it.titleOpacity !== 1)
  if (faded.length) throw new Error('任务卡片没有完全不透明（正在淡入）：' + JSON.stringify(faded))
  if (!audit || audit.toastVisible) throw new Error('任务列表上有 toast')
  if (audit.sheetOpen || !audit.modalHidden) throw new Error('任务列表上有别面板打开')
  if (audit.dateTruncated) throw new Error('顶栏日期被截断：' + audit.dateTitle)
}

function assertSyncReady(audit) {
  if (!audit) throw new Error('没有取到设置面板状态')
  if (audit.modalDisplay === 'none') throw new Error('设置面板没打开')
  if (audit.cardOpacity !== '1') throw new Error('设置面板卡片还在淡入：opacity=' + audit.cardOpacity)
  if (audit.cardAnimationPlayState === 'running') throw new Error('设置面板还在滑入：animationPlayState=running')
  if (audit.stillRunning !== 0) throw new Error('设置面板还有动画在跑：' + audit.stillRunning)
  if (!audit.rowLabel || audit.rowLabel.indexOf('电脑地址') < 0) {
    throw new Error('没找到「电脑地址」那一行，实际是：' + audit.rowLabel)
  }
  if (audit.btnText.indexOf('同步') < 0) throw new Error('「立即与电脑同步」按钮文案不对：' + audit.btnText)
  if (!audit.inputVisible) throw new Error('「电脑地址」输入框不在视口内：' + JSON.stringify(audit.inputRect))
  if (!audit.btnVisible) throw new Error('「立即与电脑同步」按钮不在视口内：' + JSON.stringify(audit.btnRect))
  if (audit.toastVisible) throw new Error('设置面板上有 toast')
}

main().catch((err) => {
  process.stdout.write('MOBILE SCREENSHOTS CRASH: ' + (err && err.stack) + '\n')
  app.exit(1)
})

/**
 * 截一张图，并且保证这一帧是"画全了的稳定帧"。
 *
 * regions 用 CSS 像素给（[x0,y0,x1,y1]），这里按比例换算到图像像素去核对：
 *   - inks / darkInks  → 该区域确实有清晰的深色文字（不是空白/幽灵帧）
 *   - alphas           → 该区域没有半透明像素（不是淡入/滑入到一半）
 *   - maxRegionInk[i]  → 该区域墨迹必须低于上限（用来验证"操作栏真被盖住了"）
 *
 * 关键一步是 alignStable()：capturePage 会返回滞后一两百毫秒的旧帧，
 * 同一个画面连截两帧、字节完全一致，才说明合成器已经追上页面状态。
 * 稳定之后还要再等一次"没有正在运行的动画"，最后才核对像素并写文件。
 */
async function capture(win, file, opts) {
  const regions = (opts && opts.regions) || []
  const minInk = (opts && opts.minInk) || 0.02
  const minDark = (opts && opts.minDark) || 0.005
  const minAlpha = (opts && opts.minAlpha) || 0.7
  const maxInk = (opts && opts.maxRegionInk) || []

  if (!win.isVisible()) {
    win.showInactive() // 显示但不抢焦点：隐藏窗口的合成器会给出空白/幽灵帧
    await sleep(900)
  }
  // 万一有 toast 弹出来了先收掉：它会盖住要拍的内容
  await win.webContents.executeJavaScript(
    '(() => { const t = document.getElementById("toast"); if (t && !t.hidden) t.hidden = true; return true })()'
  )

  const scale = (await win.webContents.executeJavaScript('window.devicePixelRatio')) || 1
  const pix = regions.map((r) => [r[0] * scale, r[1] * scale, r[2] * scale, r[3] * scale])
  const tried = []

  const readFrame = async () => {
    const img = await win.webContents.capturePage()
    const png = img.toPNG()
    const size = img.getSize()
    if (png.length < 5000 || !size.width || !size.height) return { blank: true }
    const dec = decodePng(png)
    const inks = pix.map((r) => dec.ink(r))
    const darks = pix.map((r) => dec.darkInk(r))
    const alphas = pix.map((r) => dec.alphaInk(r))
    return {
      png,
      bytes: png.length,
      width: dec.width,
      height: dec.height,
      hash: crypto.createHash('sha256').update(png).digest('hex'),
      inks,
      darks,
      alphas,
      fails: [
        ...[...inks.keys()].map((j) => ({ j, what: 'ink', v: inks[j], min: minInk })),
        ...[...darks.keys()].map((j) => ({ j, what: 'darkInk', v: darks[j], min: minDark })),
        ...[...alphas.keys()].map((j) => ({ j, what: 'alpha', v: alphas[j], min: minAlpha })),
      ].filter((f) => f.v < f.min),
      inkTooHigh: maxInk.filter(([j, cap]) => inks[j] > cap).map(([j, cap]) => ({ j, v: inks[j], cap })),
    }
  }

  for (let attempt = 1; attempt <= 4; attempt++) {
    const f1 = await readFrame()
    await sleep(320)
    const f2 = await readFrame()
    const stable = f1.hash && f2.hash && f1.hash === f2.hash
    const record = {
      attempt,
      stable,
      bytes: f2.bytes,
      inks: f2.inks,
      darkInks: f2.darks,
      alphas: f2.alphas,
      fails: f2.fails,
      inkTooHigh: f2.inkTooHigh,
    }
    tried.push(record)
    if (!stable) {
      await sleep(450)
      continue
    }
    // 稳定帧 → 再确认一次页面里确实没有正在跑的动画，最后才核对像素
    const running = await win.webContents.executeJavaScript(
      'document.getAnimations ? document.getAnimations().filter((a) => a.playState === "running").length : 0'
    )
    record.runningAnimations = running
    if (running !== 0) {
      await sleep(450)
      continue
    }
    if (f2.fails.length || f2.inkTooHigh.length) {
      await sleep(450)
      continue
    }
    fs.writeFileSync(file, f2.png)
    return {
      file,
      bytes: f2.bytes,
      width: f2.width,
      height: f2.height,
      dpr: scale,
      inks: f2.inks.map((v) => Number(v.toFixed(4))),
      darkInks: f2.darks.map((v) => Number(v.toFixed(4))),
      alphas: f2.alphas.map((v) => Number(v.toFixed(4))),
      maxInks: maxInk.map(([j]) => Number(f2.inks[j].toFixed(4))),
      attempts: attempt,
      frames: tried,
    }
  }

  throw new Error(
    `截图不合格（不是画全的稳定帧）：${file}\n` +
      JSON.stringify(tried, null, 2) +
      `\n提示：可以把 region 阈值调准，或改用 FORCE_SETTLED_SCRIPT 压掉动画。`
  )
}