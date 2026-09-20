'use strict'

/**
 * 移动端端到端冒烟自检：
 * 用 Electron（Chromium，与安卓 WebView 同内核）以【手机尺寸视口】加载 mobile/www/index.html，
 * 不注入任何 preload，验证：
 *   1) viewport 正确（否则安卓会按 ~980px 桌面宽度渲染，界面被挤扁）
 *   2) 单栏布局 + 底部操作栏 + 抽屉式表单
 *   3) 表单输入框确实全宽、字号 16px（防聚焦放大）
 *   4) store + bridge + app.js 三者协作与数据往返
 * 用法：electron mobile/test/smoke.js（退出码 0/1）
 */

const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'xinghelu-mobile-smoke-')))
app.disableHardwareAcceleration()

const errors = []

async function main() {
  await app.whenReady()
  // 常见手机逻辑分辨率（取偏窄的 360，能过就基本都能过）
  const win = new BrowserWindow({
    width: 360,
    height: 800,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })

  win.webContents.on('console-message', (...args) => {
    const ev = args[0]
    if (ev && typeof ev === 'object' && typeof ev.message === 'string') {
      if (ev.level === 'error' || ev.level === 'warning') errors.push(`${ev.level}: ${ev.message}`)
    } else {
      const level = args[1]
      if (typeof level === 'number' && level >= 2) errors.push(`level${level}: ${args[2]}`)
    }
  })
  win.webContents.on('did-fail-load', (_e, code, desc) => errors.push(`did-fail-load ${code} ${desc}`))

  await win.loadFile(path.join(__dirname, '..', 'www', 'index.html'))

  const deadline = Date.now() + 15000
  let ready = null
  while (Date.now() < deadline) {
    ready = await win.webContents.executeJavaScript('window.__memoReady || null').catch(() => null)
    if (ready && ready.hasApi) break
    await new Promise((r) => setTimeout(r, 200))
  }

  const result = await win.webContents.executeJavaScript(`(async () => {
    const $ = (id) => document.getElementById(id)
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const out = {}
    const vp = document.querySelector('meta[name="viewport"]')
    out.viewport = vp ? vp.content : ''
    out.hasApp = !!document.querySelector('.m-app')
    out.hasSidebar = !!document.querySelector('.sidebar')
    out.hasBottomBar = !!document.querySelector('.m-bottom-bar')
    out.hasTaskList = !!$('taskList')
    out.hasMemo = !!$('memo')
    out.hasCalendar = !!$('calendar')
    out.modalHidden = getComputedStyle($('settingsModal')).display === 'none'
    out.sheetsClosed =
      ['sheetComposer', 'sheetCalendar', 'sheetMemo'].every((id) => $(id) && $(id).hidden)
    out.composerFields =
      ['newTitle', 'newPriority', 'newRepeat', 'newRemind', 'newNote', 'addBtn'].every((id) => !!$(id))
    out.innerWidth = window.innerWidth

    // 顶栏日期必须完整显示（之前被挤成「202…」，副标题还被折成三行）
    const dt = $('dateTitle')
    const ds = $('dateSub')
    const headerTop = document.querySelector('.m-header-top')
    out.dateText = dt.textContent
    out.dateSubText = ds.textContent
    out.dateBoxWidth = Math.round(dt.getBoundingClientRect().width)
    out.dateTruncated = dt.scrollWidth > dt.clientWidth + 1
    out.dateSubTruncated = ds.scrollWidth > ds.clientWidth + 1
    out.headerOverflow = headerTop.scrollWidth > headerTop.clientWidth + 1
    out.headerHeight = Math.round(headerTop.getBoundingClientRect().height)

    // 任务区头部：应为两行，且「清已完成」不能被压成竖排单字
    const head = document.querySelector('.m-region-head')
    const headSpan = head ? head.querySelector('span') : null
    const headActions = head ? head.querySelector('.region-actions') : null
    const clearBtn = $('clearDoneBtn')
    out.regionHeadRows =
      headSpan && headActions
        ? headActions.getBoundingClientRect().top >= headSpan.getBoundingClientRect().bottom - 2
          ? 2
          : 1
        : 0
    if (clearBtn) {
      const rb = clearBtn.getBoundingClientRect()
      out.clearBtnW = Math.round(rb.width)
      out.clearBtnH = Math.round(rb.height)
    }
    out.regionActionsOverflow = headActions ? headActions.scrollWidth > headActions.clientWidth + 1 : false

    // 打开「添加任务」抽屉，量一下输入框是不是真的全宽
    $('openComposer').click()
    await sleep(340)
    out.sheetOpen = !$('sheetComposer').hidden
    const title = $('newTitle')
    out.titleWidth = Math.round(title.getBoundingClientRect().width)
    out.titleFontSize = getComputedStyle(title).fontSize
    out.remindWidth = Math.round($('newRemind').getBoundingClientRect().width)
    out.priorityWidth = Math.round($('newPriority').getBoundingClientRect().width)
    // 关掉
    document.querySelector('[data-close="sheetComposer"]').click()
    await sleep(300)
    out.sheetClosedAgain = $('sheetComposer').hidden

    // 数据往返
    const boot = await window.memoApi.bootstrap({})
    out.today = boot.today
    const added = await window.memoApi.addTask({ title: '冒烟任务', priority: 1 })
    out.addedId = added.task && added.task.id
    out.taskCount = added.tasks.length
    const toggled = await window.memoApi.toggleTask(out.addedId)
    out.doneAfterToggle = toggled.task.done
    out.todayDone = (await window.memoApi.getStats(boot.today)).today.done
    await window.memoApi.deleteTask(out.addedId, 'one')
    out.afterDelete = (await window.memoApi.loadDate({ date: boot.today })).tasks.length

    // 重复任务的删除：必须走真实界面路径建任务（直接调 memoApi 不会触发界面重绘，
    // DOM 里就找不到那一条），然后在真实按钮上点 ✕，验两个选项的排版。
    const REP_TITLE = '重复冒烟任务'
    $('openComposer').click()
    await sleep(380)
    $('newTitle').value = REP_TITLE
    $('newRepeat').value = 'daily'
    $('addBtn').click()
    await sleep(750)
    const repLi = [...document.querySelectorAll('.task-item')].find(
      (n) => n.querySelector('.task-title') && n.querySelector('.task-title').textContent === REP_TITLE
    )
    out.repTitle = REP_TITLE
    if (!repLi) {
      out.repMissing = true
      out.repRows = [...document.querySelectorAll('.task-item .task-title')].map((n) => n.textContent)
    } else {
      out.repId = repLi.dataset.id
      const repBtns = repLi.querySelectorAll('.task-actions .icon-btn')
      repBtns[1].click() // 点 ✕
      await sleep(240)
      const choice = repLi.querySelector('.task-actions .del-choice')
      out.delChoiceShown = !!choice && !choice.hidden
      out.delChoiceLabels = choice ? [...choice.querySelectorAll('button')].map((b) => b.textContent) : []
      out.delChoiceBoxes = choice
        ? [...choice.querySelectorAll('button')].map((b) => {
            const q = b.getBoundingClientRect()
            return {
              t: b.textContent,
              w: Math.round(q.width),
              h: Math.round(q.height),
              truncated: b.scrollWidth > b.clientWidth + 1,
            }
          })
        : []
      out.repRowOverflow = repLi.scrollWidth > repLi.clientWidth + 1
      const series = choice
        ? [...choice.querySelectorAll('button')].find((b) => b.textContent.indexOf('以后') >= 0)
        : null
      if (series) series.click()
      await sleep(700)
      out.repGone = !document.querySelector('.task-item[data-id="' + out.repId + '"]')
      out.repLeftAfter = [...document.querySelectorAll('.task-item .task-title')].filter(
        (n) => n.textContent === REP_TITLE
      ).length
    }

    // 设置必须真的落库：曾经 syncServer 不在白名单里，界面填了地址却存不下来
    await window.memoApi.saveSettings({ syncServer: '192.168.1.9:8765', syncPort: 9001 })
    const st = await window.memoApi.syncStatus()
    out.savedSyncServer = st.server
    return out
  })()`)

  const checks = []
  let failed = 0
  const assert = (name, cond, detail) => {
    if (cond) checks.push({ name, ok: true, detail: detail || '' })
    else {
      failed++
      checks.push({ name, ok: false, detail: detail || '' })
    }
  }

  assert('视口 meta 正确', /width=device-width/.test(result.viewport || ''), result.viewport)
  assert('移动端单栏布局', result.hasApp && !result.hasSidebar, `innerWidth=${result.innerWidth}`)
  assert(
    '顶栏日期完整不截断',
    !result.dateTruncated && !result.dateSubTruncated && !result.headerOverflow,
    `"${result.dateText}" / "${result.dateSubText}" 可用宽=${result.dateBoxWidth} ` +
      `标题截断=${result.dateTruncated} 副标题截断=${result.dateSubTruncated} 顶栏溢出=${result.headerOverflow}`
  )
  assert('顶栏单行不折行', result.headerHeight > 0 && result.headerHeight <= 44, `高=${result.headerHeight}`)
  assert('任务区头部两行布局', result.regionHeadRows === 2, `行数=${result.regionHeadRows}`)
  assert(
    '按钮未被压成竖排',
    result.clearBtnW > result.clearBtnH && !result.regionActionsOverflow,
    `清已完成 ${result.clearBtnW}×${result.clearBtnH} 横向溢出=${result.regionActionsOverflow}`
  )
  assert('底部操作栏存在', result.hasBottomBar, '.m-bottom-bar')
  assert('抽屉初始关闭', result.sheetsClosed, 'composer/calendar/memo')
  assert('表单字段齐全', result.composerFields, 'title/priority/repeat/remind/note/add')
  assert('抽屉可开可关', result.sheetOpen === true && result.sheetClosedAgain === true, 'open→close')
  assert(
    '输入框全宽',
    result.titleWidth >= 280 && result.remindWidth >= 280,
    `标题宽=${result.titleWidth} 提醒宽=${result.remindWidth} 视口=${result.innerWidth}`
  )
  assert('输入字号 16px', result.titleFontSize === '16px', result.titleFontSize)
  assert('优先级下拉可用', result.priorityWidth > 0, `宽=${result.priorityWidth}`)
  assert('弹窗初始隐藏', result.modalHidden, 'settingsModal')
  assert('新增任务', !!result.addedId && result.taskCount >= 1, `任务数=${result.taskCount}`)
  assert('勾选完成', result.doneAfterToggle === true && result.todayDone >= 1, 'done=true')
  assert('删除任务', result.afterDelete === 0, `剩余=${result.afterDelete}`)
  assert(
    '重复任务删除给出两个选项',
    !result.repMissing && result.delChoiceShown === true && (result.delChoiceLabels || []).length === 2,
    result.repMissing
      ? `列表里没找到「${result.repTitle}」，实际有：${JSON.stringify(result.repRows)}`
      : `选项=${JSON.stringify(result.delChoiceLabels)}`
  )
  assert(
    '删除选项未被压扁或截断',
    (result.delChoiceBoxes || []).length === 2 &&
      result.delChoiceBoxes.every((b) => b.w > b.h && b.truncated === false) &&
      result.repRowOverflow === false,
    (result.delChoiceBoxes || []).map((b) => `${b.t} ${b.w}×${b.h}${b.truncated ? ' 已截断' : ''}`).join(' · ') +
      ` 整行溢出=${result.repRowOverflow}`
  )
  assert(
    '重复任务整组删掉',
    result.repGone === true && result.repLeftAfter === 0,
    `从列表消失=${result.repGone} 剩余=${result.repLeftAfter}`
  )
  assert('设置能真正落库', result.savedSyncServer === '192.168.1.9:8765', `syncServer=${result.savedSyncServer}`)
  assert('无 console 报错', errors.length === 0, errors.slice(0, 5).join(' | '))

  const report = {
    ok: failed === 0,
    failed,
    checks,
    errors,
    measured: {
      innerWidth: result.innerWidth,
      titleWidth: result.titleWidth,
      remindWidth: result.remindWidth,
      titleFontSize: result.titleFontSize,
    },
    electron: process.versions.electron,
  }
  process.stdout.write('\n===== MOBILE SMOKE =====\n' + JSON.stringify(report, null, 2) + '\n========================\n')
  try {
    fs.writeFileSync(path.join(__dirname, '..', 'smoke-report.json'), JSON.stringify(report, null, 2), 'utf8')
  } catch (_) {
    /* 报告写不出来不影响退出码 */
  }
  app.exit(report.ok ? 0 : 1)
}

main().catch((err) => {
  process.stdout.write('MOBILE SMOKE CRASH: ' + (err && err.stack) + '\n')
  app.exit(1)
})
