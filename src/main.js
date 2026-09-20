'use strict'

/**
 * Electron 主进程：
 *  - 创建/记忆窗口
 *  - 持有唯一的数据层实例（渲染进程只能通过 IPC 访问，contextIsolation + sandbox 全开）
 *  - 每 30 秒轮询一次：跨天检测（补重复任务 + 未完成顺延）与到点提醒
 *  - --smoke 参数下走一遍自检并直接退出，用于无人值守验证
 */

const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Menu, Tray, nativeImage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const http = require('node:http')

const storeMod = require('./store')
const { Store, todayKey, isValidKey } = storeMod
const { autoUpdater } = require('electron-updater')

const isSmoke = process.argv.includes('--smoke')

if (isSmoke) {
  // 自检使用一次性目录，绝不碰用户真实数据
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'daily-memo-smoke-')))
  app.disableHardwareAcceleration()
}

let store = null
let win = null
let tray = null
let lastSeenDay = null
let tickTimer = null
let saveBoundsTimer = null
let isQuitting = false
let hiddenTipShown = false
let syncServer = null
// 开机自启时带 --hidden 启动：直接驻留托盘，不弹窗
const startHidden = process.argv.includes('--hidden')
const smoke = { errors: [], ready: null, done: false }

/* ------------------------------------------------------------------ *
 * 窗口
 * ------------------------------------------------------------------ */

function iconPath() {
  const p = path.join(__dirname, '..', 'assets', 'icon.png')
  return fs.existsSync(p) ? p : undefined
}

function createWindow() {
  const b = (store.data.meta && store.data.meta.windowBounds) || {}
  const opts = {
    width: Number.isFinite(b.width) ? b.width : 1180,
    height: Number.isFinite(b.height) ? b.height : 800,
    minWidth: 940,
    minHeight: 640,
    show: false,
    backgroundColor: '#eef1f8',
    title: '星河录',
    icon: iconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      zoomFactor: 1,
    },
  }
  if (Number.isFinite(b.x) && Number.isFinite(b.y)) {
    opts.x = b.x
    opts.y = b.y
  }

  win = new BrowserWindow(opts)

  win.once('ready-to-show', () => {
    if (!isSmoke && !startHidden) win.show()
    refreshTray()
  })

  win.on('resize', queueSaveBounds)
  win.on('move', queueSaveBounds)
  win.on('show', refreshTray)
  win.on('hide', refreshTray)

  win.on('close', (e) => {
    persistBounds()
    // 关闭按钮 → 收进托盘继续后台运行，这样到点提醒才不会丢
    if (!isQuitting && store && store.data.settings.closeToTray) {
      e.preventDefault()
      hideWindow()
      if (!hiddenTipShown) {
        hiddenTipShown = true
        try {
          if (Notification.isSupported()) {
            new Notification({
              title: '星河录仍在后台运行',
              body: '已最小化到系统托盘，到点仍会提醒你。右键托盘图标可以退出。',
            }).show()
          }
        } catch (_) {
          /* 提示成功与否不影响主流程 */
        }
      }
    }
  })

  win.on('closed', () => {
    win = null
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isSmoke) {
    win.webContents.on('console-message', (...args) => {
      const ev = args[0]
      if (ev && typeof ev === 'object' && typeof ev.message === 'string') {
        if (ev.level === 'error' || ev.level === 'warning') smoke.errors.push(`${ev.level}: ${ev.message}`)
      } else {
        const level = args[1]
        if (typeof level === 'number' && level >= 2) smoke.errors.push(`level${level}: ${args[2]}`)
      }
    })
    win.webContents.on('did-fail-load', (_e, code, desc) => smoke.errors.push(`did-fail-load ${code} ${desc}`))
    win.webContents.on('render-process-gone', (_e, d) => smoke.errors.push(`render-process-gone ${JSON.stringify(d)}`))
    win.webContents.on('preload-error', (_e, p, err) => smoke.errors.push(`preload-error ${p} ${err && err.message}`))
  }

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  return win
}

function queueSaveBounds() {
  if (saveBoundsTimer) clearTimeout(saveBoundsTimer)
  saveBoundsTimer = setTimeout(persistBounds, 600)
}

function persistBounds() {
  if (!win || win.isDestroyed() || !store) return
  try {
    const b = win.getNormalBounds ? win.getNormalBounds() : win.getBounds()
    store.data.meta.windowBounds = { x: b.x, y: b.y, width: b.width, height: b.height }
    store.save()
  } catch (_) {
    /* 窗口状态存不下来不算致命 */
  }
}

function broadcast(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

/* ------------------------------------------------------------------ *
 * 手机同步服务：电脑当服务端，手机在同一 Wi-Fi 下把数据推上来、再把合并结果拿回去
 * ------------------------------------------------------------------ */

function lanAddresses() {
  const out = []
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family === 'IPv4' && !info.internal) out.push(info.address)
    }
  }
  return out
}

function syncUrls() {
  const port = (store && Number(store.data.settings.syncPort)) || 8765
  return lanAddresses().map((ip) => `http://${ip}:${port}`)
}

function syncInfo() {
  return {
    enabled: !!(store && store.data.settings.syncEnabled),
    running: !!syncServer,
    port: (store && Number(store.data.settings.syncPort)) || 8765,
    urls: syncUrls(),
    lastSyncAt: (store && store.data.meta.lastSyncAt) || null,
    lastSyncFrom: (store && store.data.meta.lastSyncFrom) || null,
    tasks: store ? store.data.tasks.length : 0,
  }
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*', // 手机 WebView 发出的是跨源请求
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(obj))
}

function startSyncServer() {
  if (isSmoke || syncServer) return
  if (!store || !store.data.settings.syncEnabled) return
  const port = Number(store.data.settings.syncPort) || 8765
  syncServer = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') return sendJson(res, 204, {})
      const url = req.url || ''
      if (req.method === 'GET' && url.startsWith('/api/ping')) {
        return sendJson(res, 200, {
          ok: true,
          app: '星河录',
          schema: storeMod.SCHEMA_VERSION,
          tasks: store.data.tasks.length,
          time: Date.now(),
        })
      }
      if (req.method === 'POST' && url.startsWith('/api/sync')) {
        const raw = await readBody(req)
        const remote = JSON.parse(raw || '{}')
        const stat = store.mergeFrom(remote) // 先把手机的数据合进来
        store.touchSynced(req.socket.remoteAddress || '')
        const payload = store.syncPayload() // 再把合并后的结果回给手机
        broadcast('data:changed', { from: 'sync', stat })
        console.log('[sync] 已与手机同步', JSON.stringify(stat))
        return sendJson(res, 200, payload)
      }
      return sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: (err && err.message) || String(err) })
    }
  })
  syncServer.on('error', (err) => {
    console.error('[sync] 服务启动失败：', (err && err.message) || err)
    syncServer = null
  })
  syncServer.listen(port, '0.0.0.0', () => {
    console.log(`[sync] 同步服务已启动 ${syncUrls().join(' / ') || '（未检测到局域网地址）'}`)
  })
}

function stopSyncServer() {
  if (!syncServer) return
  try {
    syncServer.close()
  } catch (_) {
    /* 忽略 */
  }
  syncServer = null
}

function restartSyncServer() {
  stopSyncServer()
  startSyncServer()
}

/* ------------------------------------------------------------------ *
 * 自动更新：从 GitHub Releases 检查新版本（设置里可关）
 * 只做一次 GET 查版本号，不发任何用户数据 —— 对「离线优先」定位来说这点必须说清楚。
 * ------------------------------------------------------------------ */

let updateState = { state: 'idle', version: null, percent: 0, error: null, checkedAt: null }

/**
 * 读打包时写进 resources/app-update.yml 的更新源，判断有没有真的配过。
 * 没配就别发请求 —— 否则每次启动都往一个不存在的仓库打 404。
 */
function updateSourceInfo() {
  if (!app.isPackaged) return { configured: false, owner: null, repo: null }
  try {
    const cfg = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8')
    const owner = ((/^owner:\s*(.+)$/m.exec(cfg) || [])[1] || '').trim()
    const repo = ((/^repo:\s*(.+)$/m.exec(cfg) || [])[1] || '').trim()
    // 占位符视为「没配置」
    const configured = !!owner && !/^(YOUR_|your_|xxx)/.test(owner)
    return { configured, owner: owner || null, repo: repo || null }
  } catch (_) {
    return { configured: false, owner: null, repo: null }
  }
}

/** 把 electron-updater 那一大坨原始报错压成一句人能看懂的话 */
function friendlyUpdateError(err) {
  const raw = (err && err.message) || String(err || '')
  // electron-updater 会把底层网络错误包进这两句里，直接匹配底层关键字（ETIMEDOUT 等）
  // 常常匹配不到 —— 用户看到的就会是一整段英文原始报错。所以先认这两种包装。
  if (/Unable to find latest version on GitHub/i.test(raw)) {
    if (/\b404\b/.test(raw)) {
      return '更新源返回 404 —— 仓库或 Release 还不存在（检查 publish.owner / repo，以及是否已发布过 Release）'
    }
    return '连不上 GitHub 的发布页（本机到 github.com 的连接时好时坏），重试后仍失败；稍后会自动再试'
  }
  if (/Cannot parse releases feed/i.test(raw)) {
    return '拿不到 GitHub 的发布信息（到 github.com 的连接不稳定），稍后会自动再试'
  }
  if (/\b404\b/.test(raw)) {
    return '更新源返回 404 —— 仓库或 Release 还不存在（检查 publish.owner / repo，以及是否已发布过 Release）'
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) return '网络不可用：解析不了 github.com'
  if (/ETIMEDOUT|timeout/i.test(raw)) return '连接 GitHub 超时'
  if (/ECONNREFUSED|ECONNRESET|socket hang up/i.test(raw)) return '连接被中断'
  return raw.split('\n')[0].slice(0, 160)
}

function updateSnapshot() {
  const src = updateSourceInfo()
  return {
    ...updateState,
    current: app.getVersion(),
    supported: app.isPackaged, // 开发模式没有 app-update.yml，查不了
    enabled: !!(store && store.data.settings.autoCheckUpdate),
    sourceConfigured: src.configured,
    source: src.configured ? `${src.owner}/${src.repo}` : null,
  }
}

function pushUpdateState() {
  broadcast('update:status', updateSnapshot())
}

function notifyUpdate(title, body) {
  try {
    if (Notification.isSupported()) new Notification({ title: `星河录 · ${title}`, body }).show()
  } catch (_) {
    /* 忽略 */
  }
}

function setupUpdater() {
  const src = updateSourceInfo()
  // 先把「有没有配过更新源」反映到状态里，自检和界面都靠它
  updateState = src.configured
    ? { ...updateState, state: updateState.state || 'idle' }
    : { ...updateState, state: 'unconfigured', error: null }
  pushUpdateState()

  if (isSmoke) return // 自检不发任何网络请求
  if (!src.configured) return // 没配更新源就完全不联网

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    updateState = { ...updateState, state: 'checking', error: null }
    pushUpdateState()
  })
  autoUpdater.on('update-available', (info) => {
    updateState = { state: 'downloading', version: (info && info.version) || null, percent: 0, error: null, checkedAt: Date.now() }
    pushUpdateState()
    notifyUpdate(`发现新版本 v${(info && info.version) || ''}`, '正在后台下载，完成后会提示你重启。')
  })
  autoUpdater.on('update-not-available', () => {
    updateState = { state: 'latest', version: null, percent: 0, error: null, checkedAt: Date.now() }
    pushUpdateState()
  })
  autoUpdater.on('download-progress', (p) => {
    updateState = { ...updateState, state: 'downloading', percent: Math.round((p && p.percent) || 0) }
    pushUpdateState()
  })
  autoUpdater.on('update-downloaded', (info) => {
    updateState = { state: 'ready', version: (info && info.version) || null, percent: 100, error: null, checkedAt: Date.now() }
    pushUpdateState()
    notifyUpdate('新版本已就绪', `v${(info && info.version) || ''} 已下载完成，重启星河录即可生效。`)
  })
  autoUpdater.on('error', (err) => {
    updateState = { ...updateState, state: 'error', error: friendlyUpdateError(err), checkedAt: Date.now() }
    pushUpdateState()
  })

  // 启动后延迟检查，避免和启动抢资源；之后每 6 小时一次
  setTimeout(() => checkUpdates(false), 12000)
  setInterval(() => checkUpdates(false), 6 * 3600 * 1000)
}

/**
 * GitHub 在部分网络下时通时坏：同一个请求可能 20 秒超时，也可能 100 毫秒就返回。
 * electron-updater 对纯 github.com 是直接请求网页地址（不走 api.github.com），
 * 所以单次失败往往只是撞上了坏的那一下 —— 退避重试几次远比直接报错有用。
 */
const UPDATE_ATTEMPTS_MANUAL = 3
const UPDATE_ATTEMPTS_AUTO = 2

const sleepMs = (ms) => new Promise((res) => setTimeout(res, ms))

async function checkUpdates(manual) {
  if (!app.isPackaged) return { ok: false, reason: 'dev' }
  if (!updateSourceInfo().configured) {
    updateState = { ...updateState, state: 'unconfigured', error: null, attempt: 0, attempts: 0 }
    pushUpdateState()
    return { ok: false, reason: 'unconfigured' }
  }
  if (!manual && store && !store.data.settings.autoCheckUpdate) return { ok: false, reason: 'disabled' }

  const attempts = manual ? UPDATE_ATTEMPTS_MANUAL : UPDATE_ATTEMPTS_AUTO
  let lastErr = null

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      updateState = { ...updateState, state: 'checking', error: null, attempt, attempts }
      pushUpdateState()
      await autoUpdater.checkForUpdates()
      updateState = { ...updateState, attempt: 0, attempts: 0 }
      return { ok: true }
    } catch (err) {
      lastErr = err
      if (attempt < attempts) await sleepMs(1500 * attempt) // 1.5s、3s 退避
    }
  }

  const reason = friendlyUpdateError(lastErr)
  updateState = { ...updateState, state: 'error', error: reason, checkedAt: Date.now(), attempt: 0, attempts: 0 }
  pushUpdateState()
  return { ok: false, reason }
}

function installUpdate() {
  if (!app.isPackaged) return false
  isQuitting = true
  setImmediate(() => {
    try {
      autoUpdater.quitAndInstall()
    } catch (_) {
      app.quit()
    }
  })
  return true
}

/* ------------------------------------------------------------------ *
 * 系统托盘：关掉窗口后继续驻留，后台照常提醒
 * ------------------------------------------------------------------ */

function trayImage() {
  const p = iconPath()
  if (!p) return null
  const img = nativeImage.createFromPath(p)
  if (img.isEmpty()) return null
  return img.resize({ width: 16, height: 16, quality: 'best' })
}

function todayPendingCount() {
  if (!store) return 0
  return store.listByDate(todayKey()).filter((t) => !t.done).length
}

function showWindow() {
  if (!win || win.isDestroyed()) {
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  refreshTray()
}

function hideWindow() {
  if (!win || win.isDestroyed()) return
  win.hide()
  refreshTray()
}

function toggleWindow() {
  if (win && !win.isDestroyed() && win.isVisible()) hideWindow()
  else showWindow()
}

function refreshTray() {
  if (!tray) return
  const pending = todayPendingCount()
  const visible = !!(win && !win.isDestroyed() && win.isVisible())
  tray.setToolTip(pending > 0 ? `星河录 · 今日还有 ${pending} 项` : '星河录 · 今日已完成')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: visible ? '隐藏主窗口' : '显示主窗口', click: () => toggleWindow() },
      { label: `今日待办：${pending} 项`, enabled: false },
      { type: 'separator' },
      {
        label: '新建任务…',
        click: () => {
          showWindow()
          broadcast('focus:new-task')
        },
      },
      {
        label: '检查更新',
        click: () => {
          checkUpdates(true).then((r) => {
            if (r && r.ok === false && r.reason === 'dev') {
              notifyUpdate('开发模式', '自动更新只在打包安装后生效。')
            }
          })
        },
      },
      { label: '打开数据目录', click: () => revealDataDir() },
      { type: 'separator' },
      {
        label: '退出星河录',
        click: () => {
          isQuitting = true
          app.quit()
        },
      },
    ])
  )
}

function createTray() {
  if (isSmoke || tray) return
  const img = trayImage()
  if (!img) return
  tray = new Tray(img)
  tray.setToolTip('星河录')
  tray.on('click', () => toggleWindow())
  refreshTray()
  console.log('[tray] 系统托盘已就绪')
}

/**
 * 开机自启要带的参数。
 * 打包后是 星河录.exe --hidden；开发模式下必须把应用目录也传进去，
 * 否则开机只会启动一个空的 Electron。--hidden 让它静默驻留托盘、不弹窗。
 */
function loginItemArgs() {
  return app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden']
}

/* ------------------------------------------------------------------ *
 * 菜单（autoHideMenuBar，按 Alt 才出现；保留编辑快捷键）
 * ------------------------------------------------------------------ */

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '导出备份…', accelerator: 'CmdOrCtrl+E', click: () => ipcMain.emit('menu:export') },
        { label: '导入备份…', click: () => ipcMain.emit('menu:import') },
        { type: 'separator' },
        { label: '打开数据目录', click: () => revealDataDir() },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', click: () => win && win.reload() },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */

function datePayload(dateKey) {
  const k = isValidKey(dateKey) ? dateKey : todayKey()
  const tasks = store.listByDate(k)
  // 把当天用到的重复规则带过去，界面才能显示「每天 / 每周」而不是光秃秃的 groupId
  const repeatKinds = {}
  for (const t of tasks) {
    const g = t.groupId ? store.data.repeatGroups[t.groupId] : null
    if (g) repeatKinds[g.id] = g.repeat
  }
  return {
    date: k,
    today: todayKey(),
    tasks,
    memo: store.getMemo(k),
    stats: store.stats(k),
    repeatKinds,
  }
}

function registerIpc() {
  ipcMain.handle('app:bootstrap', (_e, payload) => {
    const today = todayKey()
    lastSeenDay = today
    store.materialize(today)
    const carried = store.carryOver(today)
    store.touchOpened()
    return {
      ...datePayload((payload && payload.date) || today),
      carried,
      settings: store.data.settings,
      dataPath: store.filePath,
      recoveredFrom: store.data.meta.recoveredFrom || null,
      reminderFiredToday: store
        .listByDate(today)
        .filter((t) => t.remindFired && t.remindFired === t.remindAt)
        .map((t) => t.id),
    }
  })

  ipcMain.handle('date:load', (_e, payload) => {
    const k = payload && payload.date
    if (!isValidKey(k)) throw new Error('日期格式不合法')
    const created = store.materialize(k)
    return { ...datePayload(k), created }
  })

  ipcMain.handle('task:add', (_e, payload) => {
    const p = payload || {}
    const task = store.addTask({
      date: p.date,
      title: p.title,
      note: p.note,
      priority: p.priority,
      type: p.type, // 别漏！漏了的话界面选了类型、新建出来还是「未分类」
      remindAt: p.remindAt,
      repeat: p.repeat,
      repeatUntil: p.repeatUntil,
    })
    const k = task.date
    store.materialize(k) // 新增的重复规则当天可能还缺实例，但不重复生成已存在的
    return { task, ...datePayload(k) }
  })

  ipcMain.handle('task:update', (_e, payload) => {
    const p = payload || {}
    const task = store.updateTask(p.id, p.patch || {}, p.scope === 'future' ? 'future' : 'one')
    if (!task) throw new Error('任务不存在')
    return task
  })

  ipcMain.handle('task:toggle', (_e, payload) => {
    const task = store.toggleTask(payload && payload.id)
    if (!task) throw new Error('任务不存在')
    return { task, stats: store.stats(task.date) }
  })

  ipcMain.handle('task:delete', (_e, payload) => {
    const p = payload || {}
    const before = store.getTask(p.id)
    const ok = store.deleteTask(p.id, p.scope === 'future' ? 'future' : 'one')
    return { ok, date: before ? before.date : todayKey(), stats: store.stats(before ? before.date : todayKey()) }
  })

  ipcMain.handle('task:reorder', (_e, payload) => {
    const p = payload || {}
    if (!isValidKey(p.date)) throw new Error('日期格式不合法')
    return store.reorder(p.date, p.ids)
  })

  ipcMain.handle('memo:set', (_e, payload) => {
    const p = payload || {}
    if (!isValidKey(p.date)) throw new Error('日期格式不合法')
    return store.setMemo(p.date, p.text)
  })

  ipcMain.handle('settings:update', (_e, patch) => {
    const p = patch || {}
    const s = store.data.settings
    if ('theme' in p && ['auto', 'light', 'dark', 'galaxy'].includes(p.theme)) s.theme = p.theme
    if ('carryOver' in p) s.carryOver = !!p.carryOver
    if ('carryOverWindowDays' in p) {
      const n = Number(p.carryOverWindowDays)
      s.carryOverWindowDays = Number.isFinite(n) ? Math.min(365, Math.max(1, Math.round(n))) : 14
    }
    if ('reminderEnabled' in p) s.reminderEnabled = !!p.reminderEnabled
    if ('closeToTray' in p) s.closeToTray = !!p.closeToTray
    if ('autoCheckUpdate' in p) s.autoCheckUpdate = !!p.autoCheckUpdate
    if ('syncEnabled' in p) {
      s.syncEnabled = !!p.syncEnabled
      restartSyncServer()
    }
    if ('syncPort' in p) {
      const n = Number(p.syncPort)
      s.syncPort = Number.isFinite(n) && n > 0 && n < 65536 ? Math.round(n) : 8765
      restartSyncServer()
    }
    if ('sortMode' in p && ['manual', 'priority', 'created'].includes(p.sortMode)) s.sortMode = p.sortMode
    if ('launchAtLogin' in p) {
      s.launchAtLogin = !!p.launchAtLogin
      try {
        // 带 --hidden 注册：开机自启时直接驻留托盘，不弹窗，但提醒照常生效
        app.setLoginItemSettings({ openAtLogin: s.launchAtLogin, openAsHidden: false, args: loginItemArgs() })
      } catch (_) {
        /* 开发模式下注册开机启动可能失败，不阻塞 */
      }
    }
    store.save()
    return s
  })

  ipcMain.handle('stats:get', (_e, payload) => store.stats(payload && payload.date))

  ipcMain.handle('sync:info', () => syncInfo())
  ipcMain.handle('sync:restart', () => {
    restartSyncServer()
    return syncInfo()
  })

  ipcMain.handle('update:status', () => updateSnapshot())
  ipcMain.handle('update:check', (_e, payload) => checkUpdates(!!(payload && payload.manual)))
  ipcMain.handle('update:install', () => installUpdate())

  ipcMain.handle('calendar:get', (_e, payload) => {
    const p = payload || {}
    const y = Number(p.year)
    const m = Number(p.month)
    if (!Number.isFinite(y) || !Number.isFinite(m)) throw new Error('年月不合法')
    return store.monthOverview(y, m)
  })

  ipcMain.handle('search', (_e, payload) => store.search(payload && payload.query))

  ipcMain.handle('data:export', async () => {
    const stamp = todayKey()
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: '导出备份',
      defaultPath: path.join(app.getPath('documents'), `每日任务备份-${stamp}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (canceled || !filePath) return { canceled: true }
    fs.writeFileSync(filePath, JSON.stringify(store.exportPayload(), null, 2), 'utf8')
    return { canceled: false, filePath }
  })

  ipcMain.handle('data:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: '导入备份',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (canceled || !filePaths || !filePaths[0]) return { canceled: true }
    const raw = fs.readFileSync(filePaths[0], 'utf8')
    const parsed = JSON.parse(raw)
    const confirm = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['取消', '覆盖导入'],
      defaultId: 0,
      cancelId: 0,
      message: '导入会覆盖当前全部数据',
      detail: '当前数据会先自动备份到数据目录，再写入文件内容。确定继续？',
    })
    if (confirm.response !== 1) return { canceled: true }
    const safety = path.join(path.dirname(store.filePath), `before-import-${Date.now()}.json`)
    fs.writeFileSync(safety, JSON.stringify(store.exportPayload(), null, 2), 'utf8')
    const summary = store.importPayload(parsed)
    lastSeenDay = todayKey()
    return { canceled: false, summary, safety }
  })

  ipcMain.handle('data:reveal', () => {
    revealDataDir()
    return true
  })

  ipcMain.on('app:ready', (_e, info) => {
    if (isSmoke) smoke.ready = info || {}
  })
}

function revealDataDir() {
  shell.showItemInFolder(store.filePath)
}

ipcMain.on('menu:export', async () => {
  const stamp = todayKey()
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '导出备份',
    defaultPath: path.join(app.getPath('documents'), `每日任务备份-${stamp}.json`),
    filters: [{ name: 'JSON', extensions: ['json'] }],
  })
  if (canceled || !filePath) return
  fs.writeFileSync(filePath, JSON.stringify(store.exportPayload(), null, 2), 'utf8')
})

ipcMain.on('menu:import', () => {
  if (win && !win.isDestroyed()) win.webContents.send('menu:request-import')
})

/* ------------------------------------------------------------------ *
 * 定时轮询：跨天 + 提醒
 * ------------------------------------------------------------------ */

function tick() {
  if (!store) return
  const today = todayKey()
  if (today !== lastSeenDay) {
    lastSeenDay = today
    store.materialize(today)
    const moved = store.carryOver(today)
    broadcast('day:changed', { today, carried: moved })
  }
  const due = store.dueReminders()
  if (due.length) {
    store.markReminded(due.map((t) => t.id))
    showReminder(due)
    broadcast('reminders:fired', { ids: due.map((t) => t.id) })
    refreshTray()
  }
}

function showReminder(tasks) {
  if (!Notification.isSupported()) return
  const title = tasks.length === 1 ? '任务提醒' : `${tasks.length} 项任务到点了`
  const body =
    tasks.length === 1
      ? tasks[0].title
      : tasks
          .slice(0, 5)
          .map((t) => `· ${t.title}`)
          .join('\n')
  try {
    const n = new Notification({ title, body, silent: false })
    n.on('click', () => {
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
        broadcast('focus:date', { date: todayKey() })
      }
    })
    n.show()
  } catch (_) {
    /* 通知失败不影响主流程 */
  }
}

/* ------------------------------------------------------------------ *
 * 自检（--smoke）
 * ------------------------------------------------------------------ */

async function runSmoke() {
  const { runSelfTest } = require('./selftest')
  const results = []
  let failed = 0
  const check = async (name, fn) => {
    try {
      const r = await fn()
      if (r === false) throw new Error('断言返回 false')
      results.push({ name, ok: true, detail: r === true || r == null ? '' : String(r) })
    } catch (err) {
      failed++
      results.push({ name, ok: false, detail: (err && err.message) || String(err) })
    }
  }

  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-memo-selftest-'))
  await check('数据层自检', () => runSelfTest(path.join(scratchDir, 'data.json')))

  // 等待渲染进程把首屏渲染完
  const deadline = Date.now() + 25000
  while (!smoke.ready && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200))

  if (!smoke.ready) {
    failed++
    results.push({ name: '渲染进程就绪', ok: false, detail: '等待 app:ready 超时' })
  } else {
    results.push({ name: '渲染进程就绪', ok: true, detail: JSON.stringify(smoke.ready) })
    await check('界面元素与首屏数据', () => {
      const info = smoke.ready
      if (!info.hasApi) throw new Error('window.memoApi 未注入')
      if (!info.hasTaskList) throw new Error('#taskList 不存在')
      if (!info.hasMemo) throw new Error('#memo 编辑区不存在')
      if (!info.hasCalendar) throw new Error('#calendar 不存在')
      if (!info.date) throw new Error('未渲染日期标题')
      if (!info.modalHidden) throw new Error('设置弹窗未隐藏（[hidden] 被 display 覆盖）')
      // 空状态应只在「有任务」时隐藏：hidden 必须与 rows>0 一致
      if (info.emptyStateHidden !== (info.rows > 0)) {
        throw new Error(`空状态隐藏状态与任务数不一致：hidden=${info.emptyStateHidden} rows=${info.rows}`)
      }
      return `日期=${info.date} 任务行=${info.rows} 日历格=${info.calCells}`
    })
  }

  await check('星辰大海主题生效', async () => {
    const r = await win.webContents.executeJavaScript(`(async () => {
      const saved = await window.memoApi.saveSettings({ theme: 'galaxy' })
      document.documentElement.dataset.theme = 'galaxy'
      const cs = getComputedStyle(document.documentElement)
      const meteors = Array.from(document.querySelectorAll('.shooting-star')).map((el) => {
        const s = getComputedStyle(el)
        return { display: s.display, anim: s.animationName, delay: s.animationDelay }
      })
      const out = {
        theme: saved && saved.theme,
        bg: cs.getPropertyValue('--bg').trim(),
        accent: cs.getPropertyValue('--accent').trim(),
        meteors,
      }
      document.documentElement.dataset.theme = 'light'
      return out
    })()`)
    if (!r || r.theme !== 'galaxy') throw new Error(`主进程未接受 galaxy 主题（返回 ${r && r.theme}）`)
    if (!r.bg || r.bg === '#eef1f8') throw new Error('星辰大海背景变量未生效（CSS 缺失或写错）')
    if (!r.accent) throw new Error('星辰大海强调色未生效')
    if (!r.meteors || r.meteors.length !== 3) throw new Error(`流星数量=${r.meteors && r.meteors.length}，期望 3`)
    if (!r.meteors.every((m) => m.display === 'block' && m.anim === 'galaxy-shooting')) {
      throw new Error('流星未在 galaxy 主题下激活：' + JSON.stringify(r.meteors))
    }
    return `theme=${r.theme} accent=${r.accent} 流星延迟=${r.meteors.map((m) => m.delay).join('/')}`
  })

  await check('任务编辑器 UI 正确', async () => {
    const r = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
      const out = {}
      // 回归：界面选了类型后新建，任务必须带上类型（曾经 IPC 漏传 type，新建全是「未分类」）
      const typeSel = document.getElementById('newType')
      if (typeSel) typeSel.value = 'work'
      document.getElementById('newTitle').value = 'UI 冒烟任务'
      document.getElementById('addBtn').click()
      await sleep(500)
      out.rows = document.querySelectorAll('.task-item').length
      out.createdTypeBadge = !!document.querySelector('.task-item .badge.type-work')
      // 注意：每次重绘都会换掉 li 节点，必须重新查询，不能复用旧引用
      const before = document.querySelector('.task-item')
      if (!before) return out
      const editBtn = before.querySelector('.task-actions .icon-btn')
      if (editBtn) editBtn.click()
      await sleep(300)
      const opened = document.querySelector('.task-item')
      const sel = opened ? opened.querySelector('.task-editor select') : null
      out.priorityOptions = sel ? sel.options.length : -1
      out.priorityTexts = sel ? Array.from(sel.options).map((o) => o.textContent).join('/') : ''
      out.remindType =
        opened && opened.querySelector('.task-editor input[type="datetime-local"]') ? 'datetime-local' : 'missing'
      const delBtns = opened ? opened.querySelectorAll('.task-actions .icon-btn') : []
      if (delBtns[1]) {
        delBtns[1].click() // 第一次：只进入待确认状态，不应真的删除
        await sleep(160)
        out.rowsAfterFirstClick = document.querySelectorAll('.task-item').length
        out.confirmLabel = delBtns[1].textContent
        delBtns[1].click() // 第二次：才真正删除
        await sleep(450)
      }
      out.rowsAfter = document.querySelectorAll('.task-item').length
      return out
    })()`)
    if (r.priorityOptions !== 3) {
      throw new Error(`优先级下拉只有 ${r.priorityOptions} 个选项（应为 3）：${r.priorityTexts}`)
    }
    if (r.remindType !== 'datetime-local') throw new Error(`提醒输入框类型=${r.remindType}，应为 datetime-local`)
    if (r.rowsAfterFirstClick !== 1) {
      throw new Error(`删除一次点击就生效了（剩余 ${r.rowsAfterFirstClick} 行），两步确认失效`)
    }
    if (!r.createdTypeBadge) throw new Error('新建任务没带上所选类型（应为「工作」徽标）')
    return `优先级=${r.priorityTexts} · 提醒=${r.remindType} · 新建带类型=${r.createdTypeBadge} · 首点后剩 ${r.rowsAfterFirstClick} 行(${r.confirmLabel}) · 二次点击后 ${r.rowsAfter} 行`
  })

  await check('重复任务删除：给出两个选项，选「今天及以后」整组消失', async () => {
    const TITLE = '重复任务冒烟'
    const r = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
      const out = {}
      document.getElementById('newTitle').value = ${JSON.stringify(TITLE)}
      const rep = document.getElementById('newRepeat')
      if (rep) rep.value = 'daily'
      document.getElementById('addBtn').click()
      await sleep(600)

      const li = [...document.querySelectorAll('.task-item')].find(
        (n) => n.querySelector('.task-title') && n.querySelector('.task-title').textContent === ${JSON.stringify(TITLE)}
      )
      if (!li) { out.error = '没找到刚建的每日重复任务'; return out }
      out.taskId = li.dataset.id

      const btns = li.querySelectorAll('.task-actions .icon-btn')
      btns[1].click() // 点 ✕
      await sleep(220)

      const choice = li.querySelector('.task-actions .del-choice')
      out.choiceShown = !!choice && !choice.hidden
      out.labels = choice ? [...choice.querySelectorAll('button')].map((b) => b.textContent) : []
      out.stillThere = !!document.querySelector('.task-item[data-id="' + out.taskId + '"]')
      // 选项按钮既不许被截断，也不许被压成竖排
      out.boxes = choice
        ? [...choice.querySelectorAll('button')].map((b) => {
            const q = b.getBoundingClientRect()
            return { t: b.textContent, w: Math.round(q.width), h: Math.round(q.height), sw: b.scrollWidth, cw: b.clientWidth }
          })
        : []

      const series = choice ? [...choice.querySelectorAll('button')].find((b) => b.textContent.indexOf('以后') >= 0) : null
      if (series) series.click()
      await sleep(800)
      out.goneFromView = !document.querySelector('.task-item[data-id="' + out.taskId + '"]')
      return out
    })()`)

    if (r.error) throw new Error(r.error)
    if (!r.choiceShown) throw new Error('重复任务点 ✕ 后没有出现删除选项，仍在按「只删今天」处理')
    if (r.labels.length !== 2) throw new Error(`删除选项应为 2 个，实际 ${r.labels.length}：${JSON.stringify(r.labels)}`)
    if (!r.stillThere) throw new Error('还没选择就把任务删掉了')
    for (const b of r.boxes) {
      if (b.sw > b.cw + 1) throw new Error(`选项「${b.t}」文字被截断（scrollWidth ${b.sw} > clientWidth ${b.cw}）`)
      if (b.w <= b.h) throw new Error(`选项「${b.t}」被压成竖排（${b.w}x${b.h}）`)
    }
    if (!r.goneFromView) throw new Error('选「今天及以后」后该任务没有从列表消失')

    // 真正的要害：删完之后，以后每一天都不能再冒出来
    const today = todayKey()
    const left = store.data.tasks.filter((t) => t.title === TITLE && t.date >= today).length
    if (left !== 0) throw new Error(`整组删除后仍残留 ${left} 条该重复任务`)
    const groupsLeft = Object.values(store.data.repeatGroups).filter((g) => g.title === TITLE).length
    if (groupsLeft !== 0) throw new Error('重复组没有被清掉，第二天还会再生成')
    store.materialize(storeMod.shiftKey(today, 1))
    const regenerated = store.listByDate(storeMod.shiftKey(today, 1)).filter((t) => t.title === TITLE).length
    if (regenerated !== 0) throw new Error(`删除后第二天又生成了 ${regenerated} 条`)

    return `选项=${r.labels.join(' / ')} · 未选前仍在 · 选后从列表消失 · 次日重新生成 ${regenerated} 条 · 重复组已清除`
  })

  await check('自动更新链路可用', async () => {
    const r = await win.webContents.executeJavaScript('window.memoApi.updateStatus()')
    if (!r || typeof r.current !== 'string') throw new Error('updateStatus 返回异常：' + JSON.stringify(r))
    if (typeof r.supported !== 'boolean' || typeof r.sourceConfigured !== 'boolean') {
      throw new Error('缺少 supported / sourceConfigured 字段')
    }
    // 自检一律在未打包状态下跑，所以这里只验证链路通、字段齐
    return `current=v${r.current} supported=${r.supported} sourceConfigured=${r.sourceConfigured} state=${r.state}`
  })

  await check('渲染进程无 console 报错', () => {
    if (smoke.errors.length) throw new Error(smoke.errors.slice(0, 5).join(' | '))
    return true
  })

  const ok = failed === 0
  const report = {
    ok,
    failed,
    checks: results,
    consoleErrors: smoke.errors,
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
  }
  process.stdout.write('\n===== SMOKE REPORT =====\n' + JSON.stringify(report, null, 2) + '\n========================\n')
  // electron.exe 是 GUI 子系统程序，stdout 未必被父进程收到，再落盘一份保证结果可取证
  try {
    fs.writeFileSync(path.join(__dirname, '..', 'smoke-report.json'), JSON.stringify(report, null, 2), 'utf8')
  } catch (_) {
    /* 报告写不出来不影响退出码 */
  }
  smoke.done = true
  setTimeout(() => app.exit(ok ? 0 : 1), 100)
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

/** 改名「星河录」后 userData 目录随之变化，把旧「daily-memo」目录里的数据一次性搬过来 */
function migrateLegacyData(newFile) {
  if (isSmoke || fs.existsSync(newFile)) return null
  try {
    const legacy = path.join(app.getPath('appData'), 'daily-memo', 'data.json')
    if (fs.existsSync(legacy)) {
      fs.mkdirSync(path.dirname(newFile), { recursive: true })
      fs.copyFileSync(legacy, newFile)
      return legacy
    }
  } catch (_) {
    /* 迁移失败不阻塞启动 */
  }
  return null
}

function boot() {
  const userData = app.getPath('userData')
  const filePath = path.join(userData, 'data.json')
  migrateLegacyData(filePath)
  store = new Store(filePath)
  store.backupOnce()

  registerIpc()
  buildMenu()
  createWindow()
  createTray()
  startSyncServer()
  setupUpdater()
  // 每次启动按当前设置重新登记开机自启，保证带上 --hidden（静默驻留托盘）
  if (store.data.settings.launchAtLogin) {
    try {
      app.setLoginItemSettings({ openAtLogin: true, openAsHidden: false, args: loginItemArgs() })
    } catch (_) {
      /* 忽略 */
    }
  }
  lastSeenDay = todayKey()
  tickTimer = setInterval(tick, 30000)
  setTimeout(tick, 3000)
}

let booted = false
if (isSmoke) {
  app.whenReady().then(() => {
    booted = true
    boot()
    runSmoke().catch((err) => {
      process.stdout.write('SMOKE CRASH: ' + (err && err.stack) + '\n')
      app.exit(1)
    })
  })
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })
  app.whenReady().then(() => {
    booted = true
    try {
      app.setAppUserModelId('com.xinghelu.desktop') // Windows 通知需要
    } catch (_) {
      /* 忽略 */
    }
    boot()
  })
  app.on('window-all-closed', () => {
    app.quit()
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

app.on('before-quit', () => {
  isQuitting = true
  if (tickTimer) clearInterval(tickTimer)
  stopSyncServer()
  persistBounds()
})

module.exports = { isSmoke, booted }
