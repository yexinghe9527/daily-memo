'use strict'

/**
 * 生成 README 用的**手机端**截图（任务列表 + 同步设置）。
 *
 * 用 Electron（与安卓 WebView 同内核）以手机视口加载 mobile/www/index.html，
 * 把 tools/demo-dataset.js 的虚构数据灌进去，然后截两张图：
 *   docs/screenshots/mobile-tasks.png  今日任务列表
 *   docs/screenshots/mobile-sync.png   设置面板（滚到「电脑地址 / 立即与电脑同步」）
 *
 * 与桌面端保持一致的做法：期望数字不是写死的，而是用**桌面端数据层**对同一份演示
 * 数据现算一遍，再要求手机端界面必须显示同样的数字。两端一旦跑偏，这里直接失败，
 * 而不是安静地产出一张和桌面端对不上的图。
 *
 * 用法：npx electron tools/screenshots-mobile.js
 */

const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const root = path.join(__dirname, '..')
const outDir = path.join(root, 'docs', 'screenshots')
const indexHtml = path.join(root, 'mobile', 'www', 'index.html')
const dataset = require('./demo-dataset')

// 关掉入场动画与过渡：截图必须拍到稳定态，而不是淡入/上滑到一半的中间帧。
// 隐藏窗口里 CSS 动画时钟不推进，更会让卡片永久卡在半透明。
const SETTLE_CSS = `*,*::before,*::after{animation:none!important;transition:none!important}`

const PRIORITY = { normal: 0, important: 1, urgent: 2 }

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'xinghelu-mobile-shots-')))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, label, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const v = await Promise.resolve()
      .then(fn)
      .catch(() => null)
    if (v) return v
    await sleep(120)
  }
  throw new Error(`等待超时：${label}`)
}

/* ------------------------------------------------------------------ *
 * 期望值：由桌面端数据层现算
 * ------------------------------------------------------------------ */

function expectedFromDesktop() {
  const { Store, todayKey } = require(path.join(root, 'src', 'store'))
  const { seed } = require('./make-demo-data')
  const file = path.join(os.tmpdir(), 'xinghelu-shots-expect', 'data.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.rmSync(file, { force: true })

  const store = new Store(file)
  seed(store)
  store.carryOver(todayKey()) // 桌面截图跑的是真实应用，启动时同样会顺延

  const s = store.stats(todayKey())
  return {
    total: s.today.total,
    done: s.today.done,
    remaining: s.today.remaining,
    streak: s.streak,
    percent: `${Math.round((s.today.done / s.today.total) * 100)}%`,
  }
}

/* ------------------------------------------------------------------ *
 * 页面内脚本
 * ------------------------------------------------------------------ */

/** 灌演示数据（此时 store 已是干净的、刚重建过的） */
function fillScript(today) {
  const payload = { settings: dataset.settings, tasks: dataset.tasks, memos: dataset.memos }
  return `(async () => {
    const api = window.memoApi
    const U = window.XingheUtils
    const dataset = ${JSON.stringify(payload)}
    const PRIORITY = ${JSON.stringify(PRIORITY)}
    const today = ${JSON.stringify(today)}

    await api.saveSettings(dataset.settings)
    await api.saveSettings({ syncServer: '' })   // 别真去连一个不存在的电脑

    for (const spec of dataset.tasks) {
      const r = await api.addTask({
        date: U.shiftKey(today, Number(spec.day) || 0),
        title: spec.title,
        note: spec.note || '',
        priority: PRIORITY[spec.priority] != null ? PRIORITY[spec.priority] : 0,
        type: spec.type || 'none',
        remindAt: spec.remindTime || null,
        repeat: spec.repeat || 'none',
      })
      if (spec.done) await api.toggleTask(r.task.id)
    }
    for (const [off, text] of Object.entries(dataset.memos || {})) {
      await api.setMemo({ date: U.shiftKey(today, Number(off) || 0), text })
    }
    // 注意：这里**不能**再调 bootstrap()。bootstrap 会执行「未完成顺延」，
    // 提前把昨天那两条搬走，最后一次重载就没东西可搬、横幅也不会弹出来。
    return { seeded: dataset.tasks.length }
  })()`
}

/** 读取界面上真正显示出来的数字 */
const READ_STATS = `(() => {
  const t = (id) => { const el = document.getElementById(id); return el ? el.textContent.trim() : null }
  const list = document.getElementById('taskList')
  const banner = document.getElementById('carryBanner')
  return {
    summary: t('taskSummary'),
    ringPct: t('ringPct'),
    remaining: t('statRemaining'),
    done: t('statDone'),
    streak: t('statStreak'),
    rows: list ? list.querySelectorAll('.task-item').length : 0,
    bannerVisible: !!(banner && !banner.hidden),
    bannerText: banner ? banner.textContent.trim() : null,
  }
})()`

/** 打开设置并滚到同步那一段，返回各元素是否真的进了视口 */
const OPEN_SYNC = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  document.getElementById('settingsBtn').click()
  const modal = document.getElementById('settingsModal')
  for (let i = 0; i < 60; i++) {
    if (modal && !modal.hidden) break
    await sleep(100)
  }
  // 面板里可能有多层可滚动容器，全部归零，再只滚「最小的量」
  const scrollables = [modal, ...modal.querySelectorAll('*')].filter(
    (el) => el.scrollHeight > el.clientHeight + 4
  )
  scrollables.forEach((el) => { el.scrollTop = 0 })

  const input = document.getElementById('syncServerInput')
  const btn = document.getElementById('syncNowBtn')
  const head = modal.querySelector('.modal-head') || modal.querySelector('header')

  const vh = window.innerHeight
  const vw = window.innerWidth
  const inView = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return r.top >= -1 && r.bottom <= vh + 1 && r.left >= -1 && r.right <= vw + 1
  }

  // 目标：同步那一整段可见，同时尽量保住「设置」标题栏。
  // 所以不直接 scrollIntoView（那会把标题栏顶出去），而是按最小的步长往下滚，
  // 一旦按钮进了视口就立刻停手。
  await sleep(120)
  if (!inView(btn)) {
    // 由内到外依次滚：最深的那层才是真正决定按钮位置的人
    const chain = scrollables.slice().reverse()
    for (const el of chain) {
      let guard = 0
      while (!inView(btn) && guard++ < 40) {
        el.scrollTop += 40
        await sleep(16)
      }
    }
  }
  await sleep(250)

  return {
    modalOpen: !modal.hidden,
    inputInView: inView(input),
    buttonInView: inView(btn),
    headInView: inView(head),
    carryChecked: document.getElementById('setCarry').checked,
  }
})()`

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  await app.whenReady()

  const win = new BrowserWindow({
    width: 390,
    height: 844,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  win.show() // 隐藏/非激活窗口的合成器会给空白帧甚至 UnknownVizError，必须真正显示

  const js = (code) => win.webContents.executeJavaScript(code)

  /** 加载 → 关动画 → 等就绪。insertCSS 在每次导航后都会失效，所以每轮都要重来 */
  const loadFresh = async () => {
    await win.loadFile(indexHtml)
    await win.webContents.insertCSS(SETTLE_CSS)
    await waitFor(() => js(`!!(window.__memoReady && window.__memoReady.hasApi)`), '页面就绪')
  }

  await loadFresh()
  const today = await js(`window.memoApi.bootstrap({}).then(r => r.today)`)

  // 清掉上一轮残留：否则重复运行会把任务再插一遍
  await js(`try { localStorage.clear() } catch (e) {} ; true`)
  await loadFresh()

  const filled = await js(fillScript(today))
  if (!filled.seeded) throw new Error('演示数据没有灌进去')

  // 再加载一次：bootstrap 会执行「未完成顺延」，昨天没做完的搬进今天——与桌面端一致
  await loadFresh()

  const stats = await waitFor(async () => {
    const s = await js(READ_STATS)
    return s.rows > 0 ? s : null
  }, '任务列表渲染')

  const expect = expectedFromDesktop()
  console.log('桌面端数据层算出 :', JSON.stringify(expect))
  console.log('手机端界面显示   :', JSON.stringify(stats))

  const problems = []
  if (!stats.summary || !stats.summary.includes(`共 ${expect.total} 项`)) {
    problems.push(`汇总行应为「共 ${expect.total} 项」，实际「${stats.summary}」`)
  }
  if (stats.remaining !== String(expect.remaining)) problems.push(`待办应为 ${expect.remaining}，实际 ${stats.remaining}`)
  if (stats.done !== String(expect.done)) problems.push(`已完成应为 ${expect.done}，实际 ${stats.done}`)
  if (stats.streak !== String(expect.streak)) problems.push(`连续达成应为 ${expect.streak}，实际 ${stats.streak}`)
  if (stats.ringPct !== expect.percent) problems.push(`完成环应为 ${expect.percent}，实际 ${stats.ringPct}`)
  if (!stats.bannerVisible) problems.push('顺延横幅没有出现')
  if (problems.length) throw new Error('手机端与桌面端不一致：\n  - ' + problems.join('\n  - '))

  fs.mkdirSync(outDir, { recursive: true })

  /** capturePage 会返回滞后的合成帧：连截两张，字节完全相同才算画面稳定 */
  async function captureStable(file) {
    let prev = null
    let lastErr = null
    for (let i = 0; i < 20; i++) {
      let image = null
      let png = null
      try {
        image = await win.webContents.capturePage()
        png = image.toPNG()
      } catch (err) {
        // 合成器偶尔会甩一个瞬时错误，重试即可，不该整轮失败
        lastErr = err
        await sleep(400)
        continue
      }
      if (prev && png.length === prev.length && png.equals(prev)) {
        fs.writeFileSync(path.join(outDir, file), png)
        return { bytes: png.length, size: image.getSize() }
      }
      prev = png
      await sleep(320)
    }
    throw new Error(`${file}：连续两次截帧不一致，画面始终没稳定下来${lastErr ? '（末次错误 ' + lastErr.message + '）' : ''}`)
  }

  const tasks = await captureStable('mobile-tasks.png')
  console.log(`✓ mobile-tasks.png  ${tasks.size.width}x${tasks.size.height}  ${(tasks.bytes / 1024).toFixed(0)} KB`)

  const sync = await js(OPEN_SYNC)
  console.log('同步设置面板 :', JSON.stringify(sync))
  if (!sync.modalOpen) throw new Error('设置面板没打开')
  if (!sync.inputInView) throw new Error('「电脑地址」输入框没有进入视口')
  if (!sync.buttonInView) throw new Error('「立即与电脑同步」按钮没有进入视口')
  if (!sync.headInView) throw new Error('「设置」标题栏被滚出了视野，面板看起来会像被裁掉')
  if (sync.carryChecked !== true) throw new Error('「未完成自动顺延到今天」应当是勾选状态')

  const syncShot = await captureStable('mobile-sync.png')
  console.log(`✓ mobile-sync.png   ${syncShot.size.width}x${syncShot.size.height}  ${(syncShot.bytes / 1024).toFixed(0)} KB`)

  await sleep(150)
  app.exit(0)
}

main().catch((err) => {
  console.error('截图失败：', (err && err.stack) || err)
  app.exit(1)
})
