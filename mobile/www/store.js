'use strict'

/**
 * 星河录 · 移动端数据层（浏览器版）
 * 与桌面版 src/store.js 的业务逻辑 1:1 一致，唯一区别：持久化从「文件 + 原子重命名」
 * 换成 localStorage（同样支持备份与损坏留档）。无任何 Node/Electron 依赖。
 *
 * 通过 window.XingheStore（Store 类）与 window.XingheUtils（工具函数）暴露。
 * Store 构造函数可注入自定义 storage（如测试用的内存实现），便于无浏览器环境自测。
 */

;(function (global) {
  const SCHEMA_VERSION = 1
  const DEFAULT_CARRY_OVER_WINDOW = 14
  const STORAGE_KEY = 'xinghelu.data.v1'
  // 错过的提醒超过这个小时数就不再补弹
  const REMIND_GRACE_HOURS = 12
  const PRIORITY_LABEL = ['普通', '重要', '紧急']

  /* ------------------------------------------------------------------ *
   * 日期工具：全部按本地时区处理，避免用 UTC 导致「晚上 8 点后跨天」
   * ------------------------------------------------------------------ */

  function toKey(date) {
    const y = date.getFullYear()
    const m = String(date.getMonth() + 1).padStart(2, '0')
    const d = String(date.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }

  function fromKey(key) {
    const [y, m, d] = String(key).split('-').map(Number)
    return new Date(y, m - 1, d)
  }

  function todayKey() {
    return toKey(new Date())
  }

  function shiftKey(key, days) {
    const d = fromKey(key)
    d.setDate(d.getDate() + days)
    return toKey(d)
  }

  function diffDays(from, to) {
    return Math.round((fromKey(to) - fromKey(from)) / 86400000)
  }

  function isValidKey(key) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(key))) return false
    const d = fromKey(key)
    return !Number.isNaN(d.getTime()) && toKey(d) === key
  }

  function uid(prefix) {
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  }

  /* ------------------------------------------------------------------ *
   * 字段校验
   * ------------------------------------------------------------------ */

  function normTitle(v) {
    const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim()
    return s.slice(0, 200) || '未命名任务'
  }

  function normNote(v) {
    return String(v == null ? '' : v).slice(0, 5000)
  }

  function normPriority(v) {
    const n = Number(v)
    return n === 0 || n === 1 || n === 2 ? n : 0
  }

  const pad2 = (n) => String(n).padStart(2, '0')

  /** Date → "YYYY-MM-DDTHH:mm"（与 <input type="datetime-local"> 的取值格式一致） */
  function toDateTimeKey(date) {
    return `${toKey(date)}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  }

  /** "2026-09-16T11:45" → "11:45"（重复任务只沿用时间部分） */
  function timeOf(dt) {
    const m = /T(\d{2}:\d{2})$/.exec(String(dt || ''))
    return m ? m[1] : null
  }

  /**
   * 提醒统一成完整的「年月日时分」："YYYY-MM-DDTHH:mm"。
   * 兼容旧数据里的纯时间写法（HH:mm），此时落到任务所属的那一天。
   */
  function normRemind(v, fallbackDate) {
    if (!v) return null
    const s = String(v).trim()
    // 完整日期时间：2026-09-16T11:45 或 2026-09-16 11:45
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{1,2})$/.exec(s)
    if (m) {
      const h = Number(m[4])
      const mi = Number(m[5])
      if (h > 23 || mi > 59) return null
      const key = `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`
      if (!isValidKey(key)) return null
      return `${key}T${pad2(h)}:${pad2(mi)}`
    }
    // 旧格式纯时间：落到任务当天
    m = /^(\d{1,2}):(\d{1,2})$/.exec(s)
    if (m) {
      const h = Number(m[1])
      const mi = Number(m[2])
      if (h > 23 || mi > 59) return null
      const day = isValidKey(fallbackDate) ? fallbackDate : todayKey()
      return `${day}T${pad2(h)}:${pad2(mi)}`
    }
    return null
  }

  const REPEAT_LABEL = {
    none: '不重复',
    daily: '每天',
    weekdays: '每个工作日',
    weekly: '每周',
    monthly: '每月',
  }

  function normRepeat(v) {
    return Object.prototype.hasOwnProperty.call(REPEAT_LABEL, v) ? v : 'none'
  }

  /** 任务类型：工作 / 私人 / 未分类 */
  const TASK_TYPES = {
    none: '未分类',
    work: '工作',
    personal: '私人',
  }

  function normType(v) {
    return Object.prototype.hasOwnProperty.call(TASK_TYPES, v) ? v : 'none'
  }

  /* ------------------------------------------------------------------ *
   * 存储后端：浏览器用 localStorage，无浏览器环境用内存实现（测试用）
   * ------------------------------------------------------------------ */

  function memoryStorage() {
    const map = {}
    const keys = []
    return {
      getItem: (k) => (k in map ? map[k] : null),
      setItem: (k, v) => {
        if (!(k in map)) keys.push(k)
        map[k] = String(v)
      },
      removeItem: (k) => {
        delete map[k]
        const i = keys.indexOf(k)
        if (i >= 0) keys.splice(i, 1)
      },
      key: (i) => (i < keys.length ? keys[i] : null),
      get length() {
        return keys.length
      },
    }
  }

  /* ------------------------------------------------------------------ *
   * Store
   * ------------------------------------------------------------------ */

  class Store {
    constructor(storage) {
      this.key = STORAGE_KEY
      this.storage = storage || (typeof localStorage !== 'undefined' ? localStorage : memoryStorage())
      this.data = this._defaults()
      this.load()
    }

    _defaults() {
      return {
        version: SCHEMA_VERSION,
        tasks: [],
        memos: {},
        repeatGroups: {},
        repeatSkips: {},
        tombstones: {}, // id → 删除时间；同步时靠它正确传播「删除」
        settings: {
          theme: 'auto', // auto | light | dark | galaxy
          carryOver: true,
          carryOverWindowDays: DEFAULT_CARRY_OVER_WINDOW,
          reminderEnabled: true,
          launchAtLogin: false,
          closeToTray: true,
          sortMode: 'manual', // manual | priority | created
          syncEnabled: true,
          syncPort: 8765,
          syncServer: '', // 电脑地址，形如 192.168.1.5:8765
          autoCheckUpdate: true,
        },
        meta: { createdAt: Date.now(), lastOpened: null, openCount: 0, lastSyncAt: null, lastSyncFrom: null },
      }
    }

    /* ---------- 读写 ---------- */

    load() {
      let raw = null
      try {
        raw = this.storage.getItem(this.key)
      } catch (_) {
        return this
      }
      if (!raw) return this // 首次运行
      try {
        this.data = this._migrate(JSON.parse(raw))
      } catch (_err) {
        // 数据损坏：留档而不是静默覆盖，用户还有机会人工抢救
        try {
          this.storage.setItem(`${this.key}.corrupt`, raw)
        } catch (_) {
          /* 留档失败也不能阻塞启动 */
        }
        this.data = this._defaults()
        this.data.meta.recoveredFrom = `localStorage://${this.key}.corrupt`
        this.save()
      }
      return this
    }

    _migrate(raw) {
      const base = this._defaults()
      if (!raw || typeof raw !== 'object') return base
      const out = {
        ...base,
        ...raw,
        settings: { ...base.settings, ...(raw.settings || {}) },
        meta: { ...base.meta, ...(raw.meta || {}) },
      }
      out.version = SCHEMA_VERSION
      out.tasks = Array.isArray(raw.tasks) ? raw.tasks.filter(Boolean).map((t) => this._normTask(t)) : []
      out.memos = raw.memos && typeof raw.memos === 'object' ? raw.memos : {}
      out.repeatGroups = raw.repeatGroups && typeof raw.repeatGroups === 'object' ? raw.repeatGroups : {}
      out.repeatSkips = raw.repeatSkips && typeof raw.repeatSkips === 'object' ? raw.repeatSkips : {}
      out.tombstones = raw.tombstones && typeof raw.tombstones === 'object' ? raw.tombstones : {}
      return out
    }

    _normTask(t) {
      const date = isValidKey(t.date) ? t.date : todayKey()
      const remindAt = normRemind(t.remindAt, date)
      return {
        id: typeof t.id === 'string' && t.id ? t.id : uid('t'),
        title: normTitle(t.title),
        note: normNote(t.note),
        date,
        done: !!t.done,
        doneAt: t.done && Number.isFinite(t.doneAt) ? t.doneAt : t.done ? Date.now() : null,
        priority: normPriority(t.priority),
        type: normType(t.type),
        remindAt,
        // 与当前提醒时间一致才算已提醒，改了时间就重新武装
        remindFired:
          typeof t.remindFired === 'string'
            ? t.remindFired
            : typeof t.remindFiredOn === 'string' && remindAt && remindAt.startsWith(t.remindFiredOn)
              ? remindAt
              : null,
        createdAt: Number.isFinite(t.createdAt) ? t.createdAt : Date.now(),
        updatedAt: Number.isFinite(t.updatedAt) ? t.updatedAt : Date.now(),
        order: Number.isFinite(t.order) ? t.order : 0,
        groupId: typeof t.groupId === 'string' && t.groupId ? t.groupId : null,
        carriedFrom: isValidKey(t.carriedFrom) ? t.carriedFrom : null,
      }
    }

    save() {
      try {
        this.storage.setItem(this.key, JSON.stringify(this.data))
      } catch (_) {
        /* 存储不可用时静默失败，避免打断操作 */
      }
      return this
    }

    /** 每天留一份备份，只保留最近 5 份 */
    backupOnce() {
      try {
        if (!this.storage.getItem(this.key)) return null
        const stamp = new Date().toISOString().slice(0, 10)
        const destKey = `${this.key}.backup.${stamp}`
        if (!this.storage.getItem(destKey)) this.storage.setItem(destKey, this.storage.getItem(this.key))
        const keys = []
        for (let i = 0; i < this.storage.length; i++) {
          const k = this.storage.key(i)
          if (k && k.startsWith(`${this.key}.backup.`)) keys.push(k)
        }
        keys.sort()
        for (const k of keys.slice(0, Math.max(0, keys.length - 5))) {
          try {
            this.storage.removeItem(k)
          } catch (_) {
            /* 忽略 */
          }
        }
        return destKey
      } catch (_) {
        return null
      }
    }

    touchOpened() {
      this.data.meta.lastOpened = Date.now()
      this.data.meta.openCount = (this.data.meta.openCount || 0) + 1
      this.save()
    }

    /* ---------- 查询 ---------- */

    getTask(id) {
      return this.data.tasks.find((t) => t.id === id) || null
    }

    listByDate(dateKey) {
      return this.data.tasks.filter((t) => t.date === dateKey).sort(this._comparator())
    }

    listRange(fromKey, toKey_) {
      return this.data.tasks.filter((t) => t.date >= fromKey && t.date <= toKey_)
    }

    _comparator() {
      const mode = this.data.settings.sortMode
      return (a, b) => {
        if (a.done !== b.done) return a.done ? 1 : -1
        if (mode === 'priority' && a.priority !== b.priority) return b.priority - a.priority
        if (mode === 'created') return a.createdAt - b.createdAt
        if (a.order !== b.order) return a.order - b.order
        return a.createdAt - b.createdAt
      }
    }

    nextOrder(dateKey) {
      let max = -1
      for (const t of this.data.tasks) if (t.date === dateKey && t.order > max) max = t.order
      return max + 1
    }

    /* ---------- 任务增删改 ---------- */

    addTask(input = {}) {
      const now = Date.now()
      const date = isValidKey(input.date) ? input.date : todayKey()
      const task = this._normTask({
        id: uid('t'),
        title: input.title,
        note: input.note,
        date,
        priority: input.priority,
        type: input.type,
        remindAt: input.remindAt,
        createdAt: now,
        updatedAt: now,
        order: this.nextOrder(date),
      })
      const repeat = normRepeat(input.repeat)
      if (repeat !== 'none') {
        const group = this.createGroup(task, repeat, input.repeatUntil)
        task.groupId = group.id
      }
      this.data.tasks.push(task)
      this.save()
      return task
    }

    createGroup(task, repeat, until) {
      const d = fromKey(task.date)
      const group = {
        id: uid('g'),
        repeat: normRepeat(repeat),
        startDate: task.date,
        endDate: isValidKey(until) ? until : null,
        weekday: d.getDay(),
        monthDay: d.getDate(),
        title: task.title,
        note: task.note,
        priority: task.priority,
        type: task.type,
        remindTime: timeOf(task.remindAt), // 重复任务只记时间，逐天套用
        createdAt: Date.now(),
      }
      this.data.repeatGroups[group.id] = group
      return group
    }

    updateTask(id, patch = {}, scope = 'one') {
      const t = this.getTask(id)
      if (!t) return null
      if ('title' in patch) t.title = normTitle(patch.title)
      if ('note' in patch) t.note = normNote(patch.note)
      if ('priority' in patch) t.priority = normPriority(patch.priority)
      if ('type' in patch) t.type = normType(patch.type)
      if ('remindAt' in patch) {
        t.remindAt = normRemind(patch.remindAt, t.date)
        t.remindFired = null
      }
      if ('date' in patch && isValidKey(patch.date)) t.date = patch.date
      if ('done' in patch) {
        t.done = !!patch.done
        t.doneAt = t.done ? Date.now() : null
      }
      t.updatedAt = Date.now()

      if (scope === 'future' && t.groupId) this._applyGroupEdit(t)
      this.save()
      return t
    }

    _applyGroupEdit(task) {
      const group = this.data.repeatGroups[task.groupId]
      if (!group) return
      group.title = task.title
      group.note = task.note
      group.priority = task.priority
      group.type = task.type
      group.remindTime = timeOf(task.remindAt) // 重复任务只沿用「时间」，日期跟着各天
      const today = todayKey()
      for (const other of this.data.tasks) {
        if (other.groupId !== task.groupId || other.id === task.id) continue
        if (other.done || other.date < today) continue
        other.title = task.title
        other.note = task.note
        other.priority = task.priority
        other.type = task.type
        other.remindAt = group.remindTime ? `${other.date}T${group.remindTime}` : null
        other.remindFired = null
        other.updatedAt = Date.now()
      }
    }

    toggleTask(id) {
      const t = this.getTask(id)
      if (!t) return null
      return this.updateTask(id, { done: !t.done }, 'one')
    }

    setDone(id, done) {
      return this.updateTask(id, { done }, 'one')
    }

    deleteTask(id, scope = 'one') {
      const t = this.getTask(id)
      if (!t) return false
      const now = Date.now()
      if (scope === 'future' && t.groupId) {
        const today = todayKey()
        for (const d of this.data.tasks) {
          if (d.groupId === t.groupId && !d.done && d.date >= today) this.data.tombstones[d.id] = now
        }
        this.data.tasks = this.data.tasks.filter((o) => !(o.groupId === t.groupId && !o.done && o.date >= today))
        this.data.tombstones[`group:${t.groupId}`] = now
        delete this.data.repeatGroups[t.groupId]
        this.save()
        return true
      }
      if (t.groupId) this.data.repeatSkips[`${t.groupId}|${t.date}`] = true
      // 删除墓碑：没有它，同步时另一端会把已删的任务又合并回来
      this.data.tombstones[id] = now
      this.data.tasks = this.data.tasks.filter((o) => o.id !== id)
      this.save()
      return true
    }

    reorder(dateKey, orderedIds) {
      const ids = Array.isArray(orderedIds) ? orderedIds : []
      ids.forEach((id, i) => {
        const t = this.getTask(id)
        if (t && t.date === dateKey) t.order = i
      })
      this.data.settings.sortMode = 'manual'
      this.save()
      return this.listByDate(dateKey)
    }

    /* ---------- 重复任务 ---------- */

    _occursOn(group, dateKey) {
      if (dateKey < group.startDate) return false
      if (group.endDate && dateKey > group.endDate) return false
      const d = fromKey(dateKey)
      switch (group.repeat) {
        case 'daily':
          return true
        case 'weekdays': {
          const w = d.getDay()
          return w >= 1 && w <= 5
        }
        case 'weekly':
          return d.getDay() === (Number.isFinite(group.weekday) ? group.weekday : fromKey(group.startDate).getDay())
        case 'monthly':
          return d.getDate() === (Number.isFinite(group.monthDay) ? group.monthDay : fromKey(group.startDate).getDate())
        default:
          return false
      }
    }

    /** 把某一天应出现的重复任务补出来（懒生成，不预先铺满未来） */
    materialize(dateKey) {
      if (!isValidKey(dateKey)) return 0
      let created = 0
      for (const group of Object.values(this.data.repeatGroups)) {
        if (!this._occursOn(group, dateKey)) continue
        if (this.data.repeatSkips[`${group.id}|${dateKey}`]) continue
        if (this.data.tasks.some((t) => t.groupId === group.id && t.date === dateKey)) continue
        this.data.tasks.push(
          this._normTask({
            id: uid('t'),
            title: group.title,
            note: group.note,
            date: dateKey,
            priority: group.priority,
            type: group.type,
            // 重复任务：把「时间」套到这一天
            remindAt: group.remindTime ? `${dateKey}T${group.remindTime}` : null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            order: this.nextOrder(dateKey),
            groupId: group.id,
          })
        )
        created++
      }
      if (created) this.save()
      return created
    }

    /* ---------- 未完成顺延 ---------- */

    carryOver(targetKey_) {
      const s = this.data.settings
      if (!s.carryOver) return 0
      const target = isValidKey(targetKey_) ? targetKey_ : todayKey()
      const win = Number(s.carryOverWindowDays) || DEFAULT_CARRY_OVER_WINDOW
      let moved = 0
      for (const t of this.data.tasks) {
        if (t.done || t.groupId) continue
        if (t.date >= target) continue
        if (diffDays(t.date, target) > win) continue
        t.carriedFrom = t.carriedFrom || t.date
        t.date = target
        t.order = this.nextOrder(target)
        t.updatedAt = Date.now()
        moved++
      }
      if (moved) this.save()
      return moved
    }

    /* ---------- 备忘 ---------- */

    getMemo(dateKey) {
      const m = this.data.memos[dateKey]
      return m && typeof m === 'object'
        ? { text: String(m.text || ''), updatedAt: m.updatedAt || null }
        : { text: '', updatedAt: null }
    }

    setMemo(dateKey, text) {
      if (!isValidKey(dateKey)) return null
      const t = String(text == null ? '' : text).slice(0, 20000)
      if (!t.trim()) {
        delete this.data.memos[dateKey]
        // 清空也要留墓碑，否则同步时会被另一端的旧内容填回来
        this.data.tombstones[`memo:${dateKey}`] = Date.now()
      } else {
        this.data.memos[dateKey] = { text: t, updatedAt: Date.now() }
      }
      this.save()
      return this.getMemo(dateKey)
    }

    /* ---------- 统计 ---------- */

    stats(todayK) {
      const today = isValidKey(todayK) ? todayK : todayKey()
      const byDate = new Map()
      let totalTasks = 0
      let totalDone = 0
      for (const t of this.data.tasks) {
        totalTasks++
        if (t.done) totalDone++
        let b = byDate.get(t.date)
        if (!b) {
          b = { total: 0, done: 0 }
          byDate.set(t.date, b)
        }
        b.total++
        if (t.done) b.done++
      }
      const get = (k) => byDate.get(k) || { total: 0, done: 0 }
      const t0 = get(today)
      const week = []
      for (let i = 6; i >= 0; i--) {
        const k = shiftKey(today, -i)
        const b = get(k)
        week.push({ date: k, total: b.total, done: b.done })
      }
      let streak = 0
      let cursor = t0.total > 0 && t0.done === t0.total ? today : shiftKey(today, -1)
      for (let guard = 0; guard < 3660; guard++) {
        const b = byDate.get(cursor)
        if (b && b.total > 0 && b.done === b.total) {
          streak++
          cursor = shiftKey(cursor, -1)
        } else break
      }
      return {
        today: { date: today, total: t0.total, done: t0.done, remaining: t0.total - t0.done },
        week,
        streak,
        totalTasks,
        totalDone,
        activeDays: byDate.size,
      }
    }

    monthOverview(year, month) {
      const first = new Date(year, month - 1, 1)
      const days = new Date(year, month, 0).getDate()
      const out = {}
      for (let i = 0; i < days; i++) {
        out[toKey(new Date(year, month - 1, i + 1))] = { total: 0, done: 0 }
      }
      const from = toKey(first)
      const to = toKey(new Date(year, month - 1, days))
      for (const t of this.data.tasks) {
        if (t.date < from || t.date > to) continue
        const b = out[t.date]
        if (!b) continue
        b.total++
        if (t.done) b.done++
      }
      return out
    }

    /* ---------- 搜索 ---------- */

    search(query, limit = 80) {
      const q = String(query || '').trim().toLowerCase()
      if (!q) return { tasks: [], memos: [], truncated: false }
      const hits = []
      for (const t of this.data.tasks) {
        const inTitle = t.title.toLowerCase().includes(q)
        const inNote = t.note.toLowerCase().includes(q)
        if (inTitle || inNote) hits.push(t)
      }
      hits.sort((a, b) => (a.date === b.date ? b.createdAt - a.createdAt : b.date.localeCompare(a.date)))
      const memoHits = []
      for (const [date, m] of Object.entries(this.data.memos)) {
        if (m && String(m.text || '').toLowerCase().includes(q)) memoHits.push({ date, text: m.text })
      }
      memoHits.sort((a, b) => b.date.localeCompare(a.date))
      return {
        tasks: hits.slice(0, limit).map((t) => ({ ...t })),
        memos: memoHits.slice(0, 20),
        truncated: hits.length > limit,
      }
    }

    /* ---------- 提醒 ---------- */

    /** 到点且还没弹过的提醒；错过超过 REMIND_GRACE_HOURS 小时的不再补弹 */
    dueReminders(now = new Date()) {
      if (!this.data.settings.reminderEnabled) return []
      const nowStr = toDateTimeKey(now)
      const cutoff = toDateTimeKey(new Date(now.getTime() - REMIND_GRACE_HOURS * 3600 * 1000))
      const out = []
      for (const t of this.data.tasks) {
        if (t.done || !t.remindAt) continue
        if (t.remindFired === t.remindAt) continue
        if (t.remindAt > nowStr) continue
        if (t.remindAt < cutoff) continue
        out.push(t)
      }
      return out
    }

    markReminded(ids) {
      for (const id of ids) {
        const t = this.getTask(id)
        if (t) t.remindFired = t.remindAt
      }
      this.save()
    }

    /* ---------- 同步：两端交换快照并按「后写入者胜出」合并 ---------- */

    syncPayload() {
      return {
        schema: SCHEMA_VERSION,
        tasks: this.data.tasks,
        memos: this.data.memos,
        repeatGroups: this.data.repeatGroups,
        tombstones: this.data.tombstones,
      }
    }

    pruneTombstones(days = 90) {
      const cutoff = Date.now() - days * 86400000
      for (const [tid, at] of Object.entries(this.data.tombstones)) {
        if (!(at > cutoff)) delete this.data.tombstones[tid]
      }
    }

    /** 记录级 LWW 合并，与桌面版逻辑一致；两端各调一次即可收敛 */
    mergeFrom(remote) {
      const stat = { tasksAdded: 0, tasksUpdated: 0, tasksDeleted: 0, memos: 0 }
      if (!remote || typeof remote !== 'object') return stat
      const rTasks = Array.isArray(remote.tasks) ? remote.tasks : []
      const rMemos = remote.memos && typeof remote.memos === 'object' ? remote.memos : {}
      const rGroups = remote.repeatGroups && typeof remote.repeatGroups === 'object' ? remote.repeatGroups : {}
      const rTombs = remote.tombstones && typeof remote.tombstones === 'object' ? remote.tombstones : {}

      for (const [tid, at] of Object.entries(rTombs)) {
        const cur = this.data.tombstones[tid]
        if (!(cur >= at)) this.data.tombstones[tid] = at
      }

      const byId = new Map(this.data.tasks.map((x) => [x.id, x]))
      for (const rt of rTasks) {
        const norm = this._normTask(rt)
        const local = byId.get(norm.id)
        if (!local) {
          this.data.tasks.push(norm)
          byId.set(norm.id, norm)
          stat.tasksAdded++
        } else if ((norm.updatedAt || 0) > (local.updatedAt || 0)) {
          Object.assign(local, norm)
          stat.tasksUpdated++
        }
      }

      for (const [gid, g] of Object.entries(rGroups)) {
        const local = this.data.repeatGroups[gid]
        if (!local || (g.createdAt || 0) > (local.createdAt || 0)) this.data.repeatGroups[gid] = g
      }

      for (const [day, m] of Object.entries(rMemos)) {
        const local = this.data.memos[day]
        if (!local || (m.updatedAt || 0) > (local.updatedAt || 0)) {
          this.data.memos[day] = m
          stat.memos++
        }
      }

      for (const [tid, at] of Object.entries(this.data.tombstones)) {
        if (tid.startsWith('memo:')) {
          const day = tid.slice(5)
          const m = this.data.memos[day]
          if (m && at >= (m.updatedAt || 0)) delete this.data.memos[day]
          continue
        }
        if (tid.startsWith('group:')) {
          const gid = tid.slice(6)
          const g = this.data.repeatGroups[gid]
          if (g && at >= (g.createdAt || 0)) delete this.data.repeatGroups[gid]
          continue
        }
        const t = byId.get(tid)
        if (t && at >= (t.updatedAt || 0)) {
          this.data.tasks = this.data.tasks.filter((x) => x.id !== tid)
          byId.delete(tid)
          stat.tasksDeleted++
        }
      }

      this.pruneTombstones()
      this.save()
      return stat
    }

    touchSynced(from) {
      this.data.meta.lastSyncAt = Date.now()
      this.data.meta.lastSyncFrom = from || null
      this.save()
    }

    /* ---------- 导入导出 ---------- */

    exportPayload() {
      return {
        app: 'xinghelu',
        schema: SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        data: this.data,
      }
    }

    importPayload(payload) {
      const data = payload && typeof payload === 'object' && payload.data ? payload.data : payload
      if (!data || typeof data !== 'object' || !Array.isArray(data.tasks)) {
        throw new Error('文件格式不对：缺少 tasks 数组')
      }
      this.data = this._migrate(data)
      this.save()
      return { tasks: this.data.tasks.length, memos: Object.keys(this.data.memos).length }
    }
  }

  global.XingheStore = Store
  global.XingheUtils = {
    toKey,
    fromKey,
    todayKey,
    shiftKey,
    diffDays,
    isValidKey,
    uid,
    normRemind,
    toDateTimeKey,
    timeOf,
    normPriority,
    normTitle,
    normRepeat,
    normType,
    TASK_TYPES,
    REPEAT_LABEL,
    PRIORITY_LABEL,
    SCHEMA_VERSION,
  }
})(typeof window !== 'undefined' ? window : globalThis)
