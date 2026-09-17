'use strict'

/**
 * 星河录 · 移动端 bridge
 * 在浏览器/WebView 里提供与桌面版 preload.js 完全一致的 window.memoApi，
 * 让 src/renderer/app.js 无需改动即可运行。数据读写走 localStorage 版 Store。
 *
 * 与桌面版的差异只在「平台能力」上做了适配：
 *  - 导出备份 → 优先系统分享（安卓体验好），退回浏览器下载
 *  - 导入备份 → 文件选择器
 *  - 到点提醒 → 应用内弹提示（真正的后台系统通知需另加本地通知插件）
 *  - 跨天检测 → 浏览器内定时器
 */

;(function () {
  const U = window.XingheUtils
  const Store = window.XingheStore
  const { todayKey, isValidKey } = U

  const store = new Store()
  store.backupOnce()

  let lastSeenDay = todayKey()
  const subs = { dayChanged: [], reminders: [], focusDate: [], requestImport: [], dataChanged: [] }

  function emit(channel, payload) {
    ;(subs[channel] || []).forEach((cb) => {
      try {
        cb(payload)
      } catch (e) {
        console.error('[bridge] 订阅回调异常', channel, e)
      }
    })
  }

  function toast(message, kind) {
    const t = document.getElementById('toast')
    if (!t) return
    t.textContent = message
    t.className = 'toast' + (kind ? ` is-${kind}` : '')
    t.hidden = false
    clearTimeout(toast._timer)
    toast._timer = setTimeout(() => {
      t.hidden = true
    }, 3000)
  }

  /* ---------- 系统通知（原生环境）：关掉应用也能提醒 ---------- */

  const CHANNEL_ID = 'xinghelu-reminders'
  const MAX_SCHEDULED = 50 // 只把最近 50 条未来提醒交给系统，避免排程过多
  let notifyReady = false

  /** Capacitor 的 JS 桥可能晚于本脚本注入，所以这里延迟探测而不是在加载时定死 */
  function isNativePlatform() {
    const Cap = window.Capacitor
    return !!(Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform())
  }

  function nativePlugin(name) {
    if (!isNativePlatform()) return null
    const Cap = window.Capacitor
    return (Cap && Cap.Plugins && Cap.Plugins[name]) || null
  }

  async function initNotifications() {
    const LN = nativePlugin('LocalNotifications')
    if (!LN) return false
    try {
      let perm = await LN.checkPermissions()
      if (!perm || perm.display !== 'granted') perm = await LN.requestPermissions()
      if (!perm || perm.display !== 'granted') return false
      try {
        await LN.createChannel({
          id: CHANNEL_ID,
          name: '任务提醒',
          description: '星河录的到点提醒',
          importance: 4, // IMPORTANCE_HIGH：会横幅弹出
          visibility: 1,
          vibration: true,
        })
      } catch (_) {
        /* 渠道可能已存在 */
      }
      LN.addListener('localNotificationActionPerformed', (action) => {
        const extra = action && action.notification && action.notification.extra
        if (extra && extra.date) emit('focusDate', { date: extra.date })
      })
      notifyReady = true
      return true
    } catch (e) {
      console.warn('[notify] 初始化失败', e)
      return false
    }
  }

  /** 把「未来的提醒」整批交给系统：应用关掉后由 Android 负责弹出 */
  async function syncNotifications() {
    const LN = nativePlugin('LocalNotifications')
    if (!LN || !notifyReady) return
    try {
      const pending = await LN.getPending()
      const olds = (pending && pending.notifications) || []
      if (olds.length) await LN.cancel({ notifications: olds.map((n) => ({ id: n.id })) })
      if (!store.data.settings.reminderEnabled) return
      const now = Date.now()
      const upcoming = store.data.tasks
        .filter((t) => !t.done && t.remindAt && t.remindFired !== t.remindAt)
        .map((t) => ({ task: t, at: new Date(String(t.remindAt).replace(' ', 'T')) }))
        .filter((x) => !Number.isNaN(x.at.getTime()) && x.at.getTime() > now)
        .sort((a, b) => a.at - b.at)
        .slice(0, MAX_SCHEDULED)
      if (!upcoming.length) return
      await LN.schedule({
        notifications: upcoming.map((x, i) => ({
          id: i + 1,
          title: '星河录 · 任务提醒',
          body: x.task.title,
          channelId: CHANNEL_ID,
          schedule: { at: x.at, allowWhileIdle: true },
          extra: { date: x.task.date, taskId: x.task.id },
        })),
      })
    } catch (e) {
      console.warn('[notify] 排程失败', e)
    }
  }

  /** Capacitor 桥可能稍后才可用，轮询等待最多 3 秒 */
  function whenCapacitor(cb) {
    if (window.Capacitor) return cb()
    let tries = 0
    const timer = setInterval(() => {
      if (window.Capacitor) {
        clearInterval(timer)
        cb()
      } else if (++tries > 60) {
        clearInterval(timer)
      }
    }, 50)
  }

  /* ---------- 与电脑同步：同一 Wi-Fi 下直连电脑的同步服务 ---------- */

  function normalizeServer(s) {
    let v = String(s || '').trim()
    if (!v) return ''
    if (!/^https?:\/\//i.test(v)) v = `http://${v}`
    return v.replace(/\/+$/, '')
  }

  async function syncNow() {
    const base = normalizeServer(store.data.settings.syncServer)
    if (!base) {
      return { ok: false, error: '还没填电脑地址。地址在电脑「设置 → 手机同步服务」里。' }
    }
    let timer = null
    try {
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
      if (ctrl) timer = setTimeout(() => ctrl.abort(), 12000)
      const res = await fetch(`${base}/api/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(store.syncPayload()),
        signal: ctrl ? ctrl.signal : undefined,
      })
      if (timer) clearTimeout(timer)
      if (!res.ok) return { ok: false, error: `电脑返回 ${res.status}` }
      const remote = await res.json()
      const stat = store.mergeFrom(remote)
      store.touchSynced(base)
      lastSeenDay = todayKey()
      emit('dataChanged', { from: 'sync', stat })
      return { ok: true, stat, at: Date.now() }
    } catch (e) {
      if (timer) clearTimeout(timer)
      const msg = e && e.name === 'AbortError' ? '连接超时' : (e && e.message) || String(e)
      return {
        ok: false,
        error: `连不上电脑（${msg}）。检查：①手机和电脑连同一个 Wi-Fi ②电脑端星河录在运行 ③地址和端口填对`,
      }
    }
  }

  function syncStatus() {
    return {
      server: store.data.settings.syncServer || '',
      lastSyncAt: store.data.meta.lastSyncAt || null,
      lastSyncFrom: store.data.meta.lastSyncFrom || null,
      tasks: store.data.tasks.length,
    }
  }

  /** 打开应用 / 回到前台时自动同步一次（没配地址就跳过） */
  async function autoSync() {
    if (!store.data.settings.syncServer) return
    await syncNow()
  }

  function datePayload(dateKey) {    const k = isValidKey(dateKey) ? dateKey : todayKey()
    const tasks = store.listByDate(k)
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

  const api = {
    bootstrap(payload) {
      const today = todayKey()
      lastSeenDay = today
      store.materialize(today)
      const carried = store.carryOver(today)
      store.touchOpened()
      syncNotifications()
      return Promise.resolve({
        ...datePayload((payload && payload.date) || today),
        carried,
        settings: store.data.settings,
        dataPath: '设备本地存储',
        recoveredFrom: store.data.meta.recoveredFrom || null,
        reminderFiredToday: store
          .listByDate(today)
          .filter((t) => t.remindFired && t.remindFired === t.remindAt)
          .map((t) => t.id),
      })
    },

    loadDate(payload) {
      const k = payload && payload.date
      if (!isValidKey(k)) return Promise.reject(new Error('日期格式不合法'))
      const created = store.materialize(k)
      return Promise.resolve({ ...datePayload(k), created })
    },

    addTask(payload) {
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
      store.materialize(k)
      syncNotifications()
      return Promise.resolve({ task, ...datePayload(k) })
    },

    updateTask(payload) {
      const p = payload || {}
      const task = store.updateTask(p.id, p.patch || {}, p.scope === 'future' ? 'future' : 'one')
      if (!task) return Promise.reject(new Error('任务不存在'))
      syncNotifications()
      return Promise.resolve(task)
    },

    toggleTask(id) {
      const task = store.toggleTask(id)
      if (!task) return Promise.reject(new Error('任务不存在'))
      syncNotifications()
      return Promise.resolve({ task, stats: store.stats(task.date) })
    },

    deleteTask(id, scope) {
      const before = store.getTask(id)
      const ok = store.deleteTask(id, scope === 'future' ? 'future' : 'one')
      const date = before ? before.date : todayKey()
      syncNotifications()
      return Promise.resolve({ ok, date, stats: store.stats(date) })
    },

    reorder(payload) {
      const p = payload || {}
      if (!isValidKey(p.date)) return Promise.reject(new Error('日期格式不合法'))
      return Promise.resolve(store.reorder(p.date, p.ids))
    },

    setMemo(payload) {
      const p = payload || {}
      if (!isValidKey(p.date)) return Promise.reject(new Error('日期格式不合法'))
      return Promise.resolve(store.setMemo(p.date, p.text))
    },

    saveSettings(patch) {
      const p = patch || {}
      const s = store.data.settings
      if ('theme' in p && ['auto', 'light', 'dark', 'galaxy'].includes(p.theme)) s.theme = p.theme
      if ('carryOver' in p) s.carryOver = !!p.carryOver
      if ('carryOverWindowDays' in p) {
        const n = Number(p.carryOverWindowDays)
        s.carryOverWindowDays = Number.isFinite(n) ? Math.min(365, Math.max(1, Math.round(n))) : 14
      }
      if ('reminderEnabled' in p) s.reminderEnabled = !!p.reminderEnabled
      if ('sortMode' in p && ['manual', 'priority', 'created'].includes(p.sortMode)) s.sortMode = p.sortMode
      if ('launchAtLogin' in p) s.launchAtLogin = !!p.launchAtLogin // 移动端无意义，仅存下
      if ('closeToTray' in p) s.closeToTray = !!p.closeToTray
      if ('syncEnabled' in p) s.syncEnabled = !!p.syncEnabled
      if ('syncPort' in p) {
        const n = Number(p.syncPort)
        s.syncPort = Number.isFinite(n) && n > 0 && n < 65536 ? Math.round(n) : 8765
      }
      // 必须在这里落库：漏掉的话界面填了电脑地址也存不下来，点同步就会报「还没填电脑地址」
      if ('syncServer' in p) s.syncServer = String(p.syncServer || '').trim()
      store.save()
      syncNotifications()
      return Promise.resolve(s)
    },

    getStats(date) {
      return Promise.resolve(store.stats(date))
    },

    getCalendar(year, month) {
      const y = Number(year)
      const m = Number(month)
      if (!Number.isFinite(y) || !Number.isFinite(m)) return Promise.reject(new Error('年月不合法'))
      return Promise.resolve(store.monthOverview(y, m))
    },

    search(query) {
      return Promise.resolve(store.search(query))
    },

    exportData() {
      const json = JSON.stringify(store.exportPayload(), null, 2)
      const filename = `星河录备份-${todayKey()}.json`
      // 安卓上优先走系统分享，体验最好；不可用则退回浏览器下载
      if (typeof navigator !== 'undefined' && navigator.share && navigator.canShare) {
        try {
          const file = new File([json], filename, { type: 'application/json' })
          if (navigator.canShare({ files: [file] })) {
            return navigator
              .share({ files: [file], title: '星河录备份' })
              .then(() => ({ canceled: false, filePath: '已分享' }))
              .catch(() => ({ canceled: true }))
          }
        } catch (_) {
          /* 继续退回下载 */
        }
      }
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      return Promise.resolve({ canceled: false, filePath: filename })
    },

    importData() {
      return new Promise((resolve) => {
        let done = false
        const finish = (val) => {
          if (!done) {
            done = true
            window.removeEventListener('focus', onFocus)
            resolve(val)
          }
        }
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = 'application/json,.json'
        input.onchange = () => {
          const file = input.files && input.files[0]
          if (!file) {
            finish({ canceled: true })
            return
          }
          const reader = new FileReader()
          reader.onload = () => {
            try {
              const parsed = JSON.parse(String(reader.result))
              const summary = store.importPayload(parsed)
              lastSeenDay = todayKey()
              finish({ canceled: false, summary })
            } catch (e) {
              finish({ canceled: false, error: (e && e.message) || String(e) })
            }
          }
          reader.onerror = () => finish({ canceled: true })
          reader.readAsText(file)
        }
        const onFocus = () => {
          // 文件选择器被取消时，窗口重新获得焦点但 onchange 不会触发
          setTimeout(() => {
            if (!done) finish({ canceled: true })
          }, 400)
        }
        window.addEventListener('focus', onFocus)
        input.click()
      })
    },

    revealData() {
      return Promise.resolve(false)
    },

    syncNow: () => syncNow(),
    syncStatus: () => Promise.resolve(syncStatus()), // 统一返回 Promise，与其它方法一致

    ready(info) {
      window.__memoReady = info || {}
      return Promise.resolve(true)
    },

    onDayChanged(cb) {
      subs.dayChanged.push(cb)
      return () => {}
    },
    onRemindersFired(cb) {
      subs.reminders.push(cb)
      return () => {}
    },
    onFocusDate(cb) {
      subs.focusDate.push(cb)
      return () => {}
    },
    onRequestImport(cb) {
      subs.requestImport.push(cb)
      return () => {}
    },
    onDataChanged(cb) {
      subs.dataChanged.push(cb)
      return () => {}
    },
  }

  /* ---------- 跨天检测 + 到点提醒（应用打开时生效） ---------- */

  function tick() {
    const today = todayKey()
    if (today !== lastSeenDay) {
      lastSeenDay = today
      store.materialize(today)
      const moved = store.carryOver(today)
      emit('dayChanged', { today, carried: moved })
    }
    const due = store.dueReminders()
    if (due.length) {
      store.markReminded(due.map((t) => t.id))
      const titles = due.map((t) => t.title)
      emit('reminders', { ids: due.map((t) => t.id), tasks: titles.map((title) => ({ title })) })
      // 原生环境交给系统通知弹出，这里不再重复提示，避免一次响两声
      if (!isNativePlatform()) {
        toast(
          titles.length === 1 ? `任务提醒：${titles[0]}` : `${titles.length} 项任务到点了：${titles.slice(0, 3).join('、')}`,
          'ok'
        )
      }
      syncNotifications()
    }
  }
  setInterval(tick, 30000)
  setTimeout(tick, 3000)

  // 原生：初始化系统通知并同步排程；回到前台时再补一次（数据可能被别处改过）
  whenCapacitor(async () => {
    if (await initNotifications()) await syncNotifications()
    setTimeout(autoSync, 1500) // 等界面渲染完再自动同步一次
  })
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      syncNotifications()
      autoSync()
    }
  })

  window.memoApi = api
})()
