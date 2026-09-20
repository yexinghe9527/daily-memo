'use strict'

/**
 * 渲染进程：界面状态与交互。
 * 所有数据都通过 window.memoApi（preload 白名单）走 IPC，这里不直接碰文件系统。
 * DOM 一律用 createElement + textContent 构建，不使用 innerHTML 拼接用户内容。
 */

;(() => {
  const api = window.memoApi
  const $ = (id) => document.getElementById(id)

  const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
  const PRIORITY_TEXT = ['普通', '重要', '紧急']
  const TYPE_TEXT = { none: '未分类', work: '工作', personal: '私人' }
  const REPEAT_TEXT = { none: '不重复', daily: '每天', weekdays: '工作日', weekly: '每周', monthly: '每月' }

  /* ------------------------------------------------ 日期小工具（本地时区） */

  const toKey = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const fromKey = (k) => {
    const [y, m, d] = String(k).split('-').map(Number)
    return new Date(y, m - 1, d)
  }
  const shiftKey = (k, n) => {
    const d = fromKey(k)
    d.setDate(d.getDate() + n)
    return toKey(d)
  }
  const diffDays = (a, b) => Math.round((fromKey(b) - fromKey(a)) / 86400000)
  const nowKey = () => toKey(new Date())

  /** 把 "2026-09-16T11:45" 显示成「今天 11:45」这种好读形式 */
  function formatRemind(dt) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})$/.exec(String(dt || ''))
    if (!m) return String(dt || '')
    const key = `${m[1]}-${m[2]}-${m[3]}`
    const rel = diffDays(state.today, key)
    const day =
      rel === 0 ? '今天' : rel === 1 ? '明天' : rel === -1 ? '昨天' : `${Number(m[2])} 月 ${Number(m[3])} 日`
    return `${day} ${m[4]}`
  }

  /** 是否已经提醒过（改了提醒时间会自动重新武装） */
  function isRemindFired(task) {
    return !!(task.remindFired && task.remindFired === task.remindAt)
  }

  const state = {
    today: nowKey(),
    date: nowKey(),
    tasks: [],
    typeFilter: 'all', // all | work | personal | none（仅界面筛选，不入库）
    updateReadyToasted: false,
    memoText: '',
    stats: null,
    settings: { theme: 'auto', sortMode: 'manual', carryOver: true, carryOverWindowDays: 14, reminderEnabled: true },
    calYear: 0,
    calMonth: 0,
    calData: {},
    repeatKinds: {},
    firedIds: new Set(),
    editingId: null,
    dragId: null,
    dataPath: '',
    memoDirty: false,
    memoStamp: null,
  }

  /* ------------------------------------------------ 通用 DOM 助手 */

  function el(tag, className, text) {
    const n = document.createElement(tag)
    if (className) n.className = className
    if (text != null) n.textContent = String(text)
    return n
  }

  let toastTimer = null
  function toast(message, kind) {
    const t = $('toast')
    t.textContent = message
    t.className = 'toast' + (kind ? ` is-${kind}` : '')
    t.hidden = false
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      t.hidden = true
    }, 2600)
  }

  function guard(fn) {
    return async (...args) => {
      try {
        return await fn(...args)
      } catch (err) {
        console.error(err)
        toast((err && err.message) || '操作失败', 'error')
        return null
      }
    }
  }

  /* ------------------------------------------------ 首屏 */

  async function init() {
    if (!api) {
      document.body.textContent = '预加载脚本未生效，界面无法访问数据。'
      return
    }
    const boot = await api.bootstrap({})
    applySettings(boot.settings)
    state.today = boot.today
    state.dataPath = boot.dataPath
    state.date = boot.date
    state.calYear = fromKey(state.date).getFullYear()
    state.calMonth = fromKey(state.date).getMonth() + 1
    applyDatePayload(boot)
    if (boot.recoveredFrom) {
      toast('上次的数据文件损坏，已留档并从空白重建', 'error')
    } else if (boot.carried > 0) {
      showCarryBanner(boot.carried)
    }
    await Promise.all([refreshCalendar(), refreshStats()])
    bindEvents()
    renderAll()
    api.ready({
      hasApi: true,
      hasTaskList: !!$('taskList'),
      hasMemo: !!$('memo'),
      hasCalendar: !!$('calendar'),
      date: state.date,
      rows: document.querySelectorAll('.task-item').length,
      calCells: document.querySelectorAll('.cal-cell:not(.is-blank)').length,
      // 用于冒烟测试防回归：这些元素带 hidden 属性时，计算样式必须是 none
      modalHidden: getComputedStyle($('settingsModal')).display === 'none',
      emptyStateHidden: getComputedStyle($('emptyState')).display === 'none',
    })
    setTimeout(() => $('newTitle').focus(), 60)
  }

  function applyDatePayload(p) {
    state.date = p.date
    state.today = p.today
    state.tasks = p.tasks || []
    state.repeatKinds = p.repeatKinds || {}
    state.memoText = (p.memo && p.memo.text) || ''
    state.memoStamp = (p.memo && p.memo.updatedAt) || null
    if (p.stats) state.stats = p.stats
    state.editingId = null
    state.memoDirty = false
  }

  function applySettings(s) {
    state.settings = Object.assign({}, state.settings, s || {})
    const mode = state.settings.theme
    let resolved = mode
    if (mode === 'auto') {
      resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    }
    document.documentElement.dataset.theme = resolved
    const sortSel = $('sortMode')
    if (sortSel) sortSel.value = state.settings.sortMode
  }

  /* ------------------------------------------------ 整体渲染 */

  function renderAll() {
    renderDateHeader()
    renderTasks()
    renderStats()
    renderMemo()
    syncSettingsForm()
  }

  function renderDateHeader() {
    const d = fromKey(state.date)
    $('dateTitle').textContent = `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`
    const rel = diffDays(state.today, state.date)
    const relText = rel === 0 ? '今天' : rel === 1 ? '明天' : rel === -1 ? '昨天' : rel > 0 ? `${rel} 天后` : `${-rel} 天前`
    $('dateSub').textContent = `${WEEKDAYS[d.getDay()]} · ${relText}`
    $('todayBtn').disabled = state.date === state.today
    const open = state.tasks.filter((t) => !t.done).length
    document.title = open > 0 ? `(${open}) 星河录` : '星河录'
  }

  function renderStats() {
    const s = state.stats
    if (!s) return
    const total = s.today.total
    const done = s.today.done
    const pct = total === 0 ? 0 : Math.round((done / total) * 100)
    const c = 2 * Math.PI * 52
    const ring = $('progressRing')
    const value = $('ringValue')
    value.style.strokeDasharray = String(c)
    value.style.strokeDashoffset = String(c * (1 - pct / 100))
    ring.classList.toggle('is-complete', total > 0 && done === total)
    $('ringPct').textContent = `${pct}%`
    $('ringHint').textContent = total === 0 ? '今天还没有任务' : total > 0 && done === total ? '全部完成 🎉' : `还剩 ${total - done} 项`
    $('statRemaining').textContent = String(s.today.remaining)
    $('statDone').textContent = String(done)
    $('statStreak').textContent = String(s.streak)

    const weekBars = $('weekBars')
    weekBars.textContent = ''
    const max = Math.max(1, ...s.week.map((d) => d.total))
    let weekDone = 0
    let weekTotal = 0
    for (const day of s.week) {
      weekDone += day.done
      weekTotal += day.total
      const bar = el('div', 'week-bar')
      if (day.date === state.today) bar.classList.add('is-today')
      const track = el('div', 'bar')
      const h = day.total === 0 ? 4 : Math.max(10, Math.round((day.total / max) * 46))
      track.style.height = `${h}px`
      const doneH = day.total === 0 ? 0 : Math.round((day.done / day.total) * h)
      if (doneH > 0) {
        const i = el('i', 'done-part')
        i.style.height = `${doneH}px`
        track.appendChild(i)
      }
      bar.appendChild(track)
      bar.appendChild(el('span', null, String(fromKey(day.date).getDate())))
      bar.title = `${day.date}：完成 ${day.done} / 共 ${day.total}`
      bar.addEventListener('click', () => goToDate(day.date))
      weekBars.appendChild(bar)
    }
    $('weekTotal').textContent = `${weekDone}/${weekTotal}`

    const total2 = s.today.total
    $('taskSummary').textContent =
      total2 === 0 ? '暂无任务' : `共 ${total2} 项 · 已完成 ${done} 项 · 待办 ${total2 - done} 项`
  }

  function renderMemo() {
    const memo = $('memo')
    if (document.activeElement !== memo) memo.value = state.memoText
    $('memoSaved').textContent = state.memoText.trim()
      ? state.memoStamp
        ? `已保存 ${new Date(state.memoStamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
        : '已保存'
      : ''
  }

  /* ------------------------------------------------ 任务列表 */

  function renderTasks() {
    const list = $('taskList')
    list.textContent = ''
    const filtering = state.typeFilter !== 'all'
    const visible = filtering ? state.tasks.filter((t) => (t.type || 'none') === state.typeFilter) : state.tasks
    const empty = $('emptyState')
    empty.hidden = visible.length > 0
    if (visible.length === 0) {
      const rel = diffDays(state.today, state.date)
      $('emptyText').textContent = filtering
        ? `这一天没有「${TYPE_TEXT[state.typeFilter]}」类型的任务。`
        : rel === 0
          ? '今天还没有任务，在上面输入框里加一条吧。'
          : rel < 0
            ? '这一天没有留下任务记录。'
            : '这一天还没有安排任务。'
    }
    for (const task of visible) list.appendChild(buildTaskItem(task))
  }

  function buildTaskItem(task) {
    const li = el('li', 'task-item')
    li.dataset.id = task.id
    li.dataset.priority = String(task.priority)
    li.draggable = state.editingId !== task.id
    if (task.done) li.classList.add('is-done')
    if (state.firedIds.has(task.id)) li.classList.add('is-reminded')

    li.appendChild(el('span', 'drag-handle', '⠿'))

    const check = el('button', 'check', '✓')
    check.title = task.done ? '标记为未完成' : '标记为完成'
    check.addEventListener('click', guard(async () => {
      const r = await api.toggleTask(task.id)
      if (!r) return
      const t = state.tasks.find((x) => x.id === task.id)
      if (t) {
        t.done = r.task.done
        t.doneAt = r.task.doneAt
      }
      state.tasks.sort(taskComparator)
      await refreshStats()
      renderAll()
      await refreshCalendar()
    }))
    li.appendChild(check)

    const body = el('div', 'task-body')
    const title = el('div', 'task-title', task.title)
    title.title = '双击编辑'
    title.addEventListener('dblclick', () => {
      state.editingId = task.id
      renderTasks()
      const input = document.querySelector(`.task-item[data-id="${task.id}"] .editor-title`)
      if (input) {
        input.focus()
        input.select()
      }
    })
    body.appendChild(title)

    if (task.note) body.appendChild(el('div', 'task-note', task.note))

    const badges = el('div', 'task-badges')
    if (task.priority > 0) badges.appendChild(el('span', `badge pri-${task.priority}`, PRIORITY_TEXT[task.priority]))
    if (task.remindAt) {
      const fired = isRemindFired(task)
      badges.appendChild(
        el('span', `badge remind${fired ? ' is-fired' : ''}`, `${fired ? '已提醒' : '提醒'} ${formatRemind(task.remindAt)}`)
      )
    }
    if (task.type && task.type !== 'none') badges.appendChild(el('span', `badge type-${task.type}`, TYPE_TEXT[task.type]))
    if (task.groupId) badges.appendChild(el('span', 'badge repeat', '重复'))
    if (task.carriedFrom) {
      const d = fromKey(task.carriedFrom)
      badges.appendChild(el('span', 'badge carried', `顺延自 ${d.getMonth() + 1}/${d.getDate()}`))
    }
    if (task.done && task.doneAt) {
      badges.appendChild(el('span', 'badge', `完成于 ${new Date(task.doneAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`))
    }
    if (badges.childNodes.length) body.appendChild(badges)

    if (state.editingId === task.id) body.appendChild(buildEditor(task))
    li.appendChild(body)

    const actions = el('div', 'task-actions')
    const editBtn = el('button', 'icon-btn', '✎')
    editBtn.title = '编辑'
    editBtn.addEventListener('click', () => {
      state.editingId = state.editingId === task.id ? null : task.id
      renderTasks()
      if (state.editingId) {
        const input = document.querySelector(`.task-item[data-id="${task.id}"] .editor-title`)
        if (input) {
          input.focus()
          input.select()
        }
      }
    })
    actions.appendChild(editBtn)

    const delBtn = el('button', 'icon-btn danger', '✕')
    delBtn.title = '删除'
    let confirming = false
    let confirmTimer = null
    const clearTimer = () => {
      if (confirmTimer) clearTimeout(confirmTimer)
      confirmTimer = null
    }
    const resetConfirm = () => {
      confirming = false
      delBtn.classList.remove('is-confirming')
      delBtn.textContent = '✕'
      delBtn.title = '删除'
      clearTimer()
    }

    // 重复任务：删「这一次」和删「整个重复」是两件完全不同的事，必须让用户选。
    // 以前一律只删当天，结果第二天它又生成出来，看起来就像根本没删掉。
    const choice = el('div', 'del-choice')
    choice.hidden = true
    const hideChoice = () => {
      choice.hidden = true
      delBtn.hidden = false
      clearTimer()
    }
    const doDelete = guard(async (scope) => {
      const r = await api.deleteTask(task.id, scope)
      if (!r || !r.ok) return
      resetConfirm()
      hideChoice()
      // 整组删除会牵动多天，直接按服务端结果重画一遍，不在本地另行推算
      await reloadDate()
      toast(scope === 'future' ? '已删除今天及以后' : '已删除', 'ok')
    })
    const onceBtn = el('button', 'icon-btn', '只删今天')
    onceBtn.title = '只跳过这一天，以后照常重复'
    onceBtn.addEventListener('click', () => doDelete('one'))
    const seriesBtn = el('button', 'icon-btn danger', '今天及以后')
    seriesBtn.title = '删掉今天和以后所有未完成的，并结束这个重复'
    seriesBtn.addEventListener('click', () => doDelete('future'))
    choice.appendChild(onceBtn)
    choice.appendChild(seriesBtn)

    delBtn.addEventListener('click', guard(async () => {
      if (task.groupId) {
        // 重复任务：一次点击就摆出两个明确选项，5 秒不选自动收起
        delBtn.hidden = true
        choice.hidden = false
        clearTimer()
        confirmTimer = setTimeout(hideChoice, 5000)
        return
      }
      // 非重复任务：两步确认，第一次点击只进入待确认状态，避免和「编辑」相邻被误点删掉
      if (!confirming) {
        confirming = true
        delBtn.classList.add('is-confirming')
        delBtn.textContent = document.body.classList.contains('mobile') ? '确认' : '确认删除'
        delBtn.title = '再点一次确认删除'
        confirmTimer = setTimeout(resetConfirm, 3000)
        return
      }
      doDelete('one')
    }))
    actions.appendChild(delBtn)
    actions.appendChild(choice)
    li.appendChild(actions)

    attachDrag(li, task)
    return li
  }

  function buildEditor(task) {
    const wrap = el('div', 'task-editor')

    const titleInput = el('input', 'editor-title')
    titleInput.value = task.title
    titleInput.maxLength = 200
    titleInput.placeholder = '任务内容'
    wrap.appendChild(titleInput)

    const noteInput = el('textarea', 'editor-note')
    noteInput.value = task.note || ''
    noteInput.placeholder = '备注（可选）'
    wrap.appendChild(noteInput)

    const row = el('div', 'editor-row')

    const priLabel = el('label')
    priLabel.appendChild(el('span', null, '优先级'))
    const priSel = el('select')
    PRIORITY_TEXT.forEach((text, i) => {
      const o = el('option', null, text)
      o.value = String(i)
      priSel.appendChild(o) // 必须挂到 select 上；挂到 label 上会变成死文字且下拉框空白
    })
    priSel.value = String(task.priority)
    priLabel.appendChild(priSel)
    row.appendChild(priLabel)

    const typeLabel = el('label')
    typeLabel.appendChild(el('span', null, '类型'))
    const typeSel = el('select')
    Object.keys(TYPE_TEXT).forEach((key) => {
      const o = el('option', null, TYPE_TEXT[key])
      o.value = key
      typeSel.appendChild(o)
    })
    typeSel.value = task.type || 'none'
    typeLabel.appendChild(typeSel)
    row.appendChild(typeLabel)

    const remLabel = el('label')
    remLabel.appendChild(el('span', null, '提醒'))
    const remInput = el('input')
    remInput.type = 'datetime-local' // 完整到「年月日时分」，不再只限当日时间
    remInput.value = task.remindAt || ''
    remLabel.appendChild(remInput)
    row.appendChild(remLabel)

    if (task.groupId) {
      const repLabel = el('label')
      repLabel.appendChild(el('span', null, '重复'))
      repLabel.appendChild(el('span', 'muted', REPEAT_TEXT[repeatOf(task)] || '重复'))
      row.appendChild(repLabel)
    }
    wrap.appendChild(row)

    const actions = el('div', 'editor-actions')
    const saveBtn = el('button', 'primary-btn', task.groupId ? '保存（仅此条）' : '保存')
    saveBtn.addEventListener('click', guard(async () => {
      await api.updateTask({
        id: task.id,
        patch: {
          title: titleInput.value,
          note: noteInput.value,
          priority: Number(priSel.value),
          type: typeSel.value,
          remindAt: remInput.value || null,
        },
        scope: 'one',
      })
      await reloadDate()
      toast('已保存', 'ok')
    }))
    actions.appendChild(saveBtn)

    if (task.groupId) {
      const saveAllBtn = el('button', 'ghost-btn', '保存并应用到以后')
      saveAllBtn.addEventListener('click', guard(async () => {
        await api.updateTask({
          id: task.id,
          patch: {
            title: titleInput.value,
            note: noteInput.value,
            priority: Number(priSel.value),
          type: typeSel.value,
            remindAt: remInput.value || null,
          },
          scope: 'future',
        })
        await reloadDate()
        toast('已应用到以后各天', 'ok')
      }))
      actions.appendChild(saveAllBtn)
    }

    const cancelBtn = el('button', 'ghost-btn', '取消')
    cancelBtn.addEventListener('click', () => {
      state.editingId = null
      renderTasks()
    })
    actions.appendChild(cancelBtn)
    wrap.appendChild(actions)

    const keyHandler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        state.editingId = null
        renderTasks()
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        saveBtn.click()
      }
    }
    titleInput.addEventListener('keydown', keyHandler)
    noteInput.addEventListener('keydown', keyHandler)
    return wrap
  }

  function repeatOf(task) {
    return task.groupId ? state.repeatKinds[task.groupId] : null
  }

  function taskComparator(a, b) {
    if (a.done !== b.done) return a.done ? 1 : -1
    const mode = state.settings.sortMode
    if (mode === 'priority' && a.priority !== b.priority) return b.priority - a.priority
    if (mode === 'created') return a.createdAt - b.createdAt
    if (a.order !== b.order) return a.order - b.order
    return a.createdAt - b.createdAt
  }

  /* ------------------------------------------------ 拖拽排序 */

  function attachDrag(li, task) {
    li.addEventListener('dragstart', (e) => {
      state.dragId = task.id
      li.classList.add('is-dragging')
      e.dataTransfer.effectAllowed = 'move'
      try {
        e.dataTransfer.setData('text/plain', task.id)
      } catch (_) {
        /* 某些环境不允许设置数据，忽略即可 */
      }
    })
    li.addEventListener('dragend', () => {
      state.dragId = null
      li.classList.remove('is-dragging')
      document.querySelectorAll('.is-drop-target').forEach((n) => n.classList.remove('is-drop-target'))
    })
    li.addEventListener('dragover', (e) => {
      if (!state.dragId || state.dragId === task.id) return
      e.preventDefault()
      li.classList.add('is-drop-target')
    })
    li.addEventListener('dragleave', () => li.classList.remove('is-drop-target'))
    li.addEventListener('drop', guard(async (e) => {
      e.preventDefault()
      li.classList.remove('is-drop-target')
      const dragId = state.dragId
      if (!dragId || dragId === task.id) return
      const ids = [...document.querySelectorAll('.task-item')].map((n) => n.dataset.id)
      const from = ids.indexOf(dragId)
      if (from < 0) return
      ids.splice(from, 1)
      ids.splice(ids.indexOf(task.id), 0, dragId)
      const list = await api.reorder({ date: state.date, ids })
      if (!list) return
      state.tasks = list
      state.settings.sortMode = 'manual'
      $('sortMode').value = 'manual'
      renderTasks()
    }))
  }

  /* ------------------------------------------------ 日历 */

  async function refreshCalendar() {
    const data = await api.getCalendar(state.calYear, state.calMonth)
    state.calData = data || {}
    renderCalendar()
  }

  function renderCalendar() {
    const grid = $('calendar')
    grid.textContent = ''
    $('calTitle').textContent = `${state.calYear} 年 ${state.calMonth} 月`
    const first = new Date(state.calYear, state.calMonth - 1, 1)
    const days = new Date(state.calYear, state.calMonth, 0).getDate()
    for (let i = 0; i < first.getDay(); i++) grid.appendChild(el('div', 'cal-cell is-blank'))

    for (let day = 1; day <= days; day++) {
      const key = toKey(new Date(state.calYear, state.calMonth - 1, day))
      const cell = el('button', 'cal-cell')
      cell.type = 'button'
      if (key === state.today) cell.classList.add('is-today')
      if (key === state.date) cell.classList.add('is-selected')
      cell.appendChild(el('span', null, String(day)))
      const info = state.calData[key]
      const dots = el('div', 'dots')
      if (info && info.total > 0) {
        if (info.done > 0) dots.appendChild(el('i', 'dot has-done'))
        if (info.total - info.done > 0) dots.appendChild(el('i', 'dot has-open'))
      }
      cell.appendChild(dots)
      cell.title = info && info.total ? `${info.date || key}：完成 ${info.done}/${info.total}` : key
      cell.addEventListener('click', () => goToDate(key))
      grid.appendChild(cell)
    }
  }

  /* ------------------------------------------------ 统计刷新 */

  async function refreshStats() {
    const s = await api.getStats(state.date)
    if (s) state.stats = s
  }

  /* ------------------------------------------------ 日期切换 */

  const goToDate = guard(async (key) => {
    flushMemo()
    const payload = await api.loadDate({ date: key })
    if (!payload) return
    applyDatePayload(payload)
    const d = fromKey(key)
    if (d.getFullYear() !== state.calYear || d.getMonth() + 1 !== state.calMonth) {
      state.calYear = d.getFullYear()
      state.calMonth = d.getMonth() + 1
    }
    renderAll()
    await Promise.all([refreshCalendar(), refreshStats()])
    renderAll()
  })

  async function reloadDate() {
    const payload = await api.loadDate({ date: state.date })
    if (!payload) return
    applyDatePayload(payload)
    renderAll()
    await Promise.all([refreshCalendar(), refreshStats()])
    renderAll()
  }

  function showCarryBanner(n) {
    const b = $('carryBanner')
    b.textContent = ''
    b.appendChild(el('span', null, `已把 ${n} 项未完成的任务顺延到今天`))
    const close = el('button', null, '知道了 ✕')
    close.addEventListener('click', () => {
      b.hidden = true
    })
    b.appendChild(close)
    b.hidden = false
  }

  /* ------------------------------------------------ 备忘自动保存 */

  let memoTimer = null
  function scheduleMemoSave() {
    state.memoDirty = true
    $('memoSaved').textContent = '编辑中…'
    if (memoTimer) clearTimeout(memoTimer)
    memoTimer = setTimeout(flushMemo, 600)
  }

  const flushMemo = guard(async () => {
    if (memoTimer) {
      clearTimeout(memoTimer)
      memoTimer = null
    }
    if (!state.memoDirty) return
    const text = $('memo').value
    const saved = await api.setMemo({ date: state.date, text })
    state.memoText = (saved && saved.text) || ''
    state.memoStamp = (saved && saved.updatedAt) || null
    state.memoDirty = false
    renderMemo()
  })

  /* ------------------------------------------------ 搜索 */

  let searchTimer = null
  const runSearch = guard(async (query) => {
    const box = $('searchResults')
    const q = String(query || '').trim()
    if (!q) {
      box.hidden = true
      box.textContent = ''
      return
    }
    const res = await api.search(q)
    box.textContent = ''
    if (!res || (res.tasks.length === 0 && res.memos.length === 0)) {
      box.appendChild(el('div', 'search-empty', `没有找到「${q}」`))
    } else {
      if (res.tasks.length) {
        box.appendChild(el('div', 'search-group-title', `任务（${res.tasks.length}）`))
        for (const t of res.tasks) {
          const hit = el('button', 'search-hit')
          hit.type = 'button'
          hit.appendChild(highlight(t.title, q, 'b'))
          hit.appendChild(el('span', null, `${t.date} · ${t.done ? '已完成' : '待办'}${t.note ? ' · ' + t.note.slice(0, 40) : ''}`))
          hit.addEventListener('click', () => {
            box.hidden = true
            $('searchInput').value = ''
            goToDate(t.date).then(() => {
              state.editingId = t.id
              renderTasks()
            })
          })
          box.appendChild(hit)
        }
      }
      if (res.memos.length) {
        box.appendChild(el('div', 'search-group-title', `备忘（${res.memos.length}）`))
        for (const m of res.memos) {
          const hit = el('button', 'search-hit')
          hit.type = 'button'
          hit.appendChild(highlight(m.text.slice(0, 60), q, 'b'))
          hit.appendChild(el('span', null, m.date))
          hit.addEventListener('click', () => {
            box.hidden = true
            $('searchInput').value = ''
            goToDate(m.date)
          })
          box.appendChild(hit)
        }
      }
    }
    box.hidden = false
  })

  function highlight(text, query, tag) {
    const node = el(tag)
    const lower = String(text).toLowerCase()
    const q = String(query).toLowerCase()
    let i = lower.indexOf(q)
    if (i < 0 || !q) {
      node.textContent = String(text)
      return node
    }
    let rest = String(text)
    let offset = 0
    const frag = document.createDocumentFragment()
    while (i >= 0) {
      frag.appendChild(document.createTextNode(rest.slice(offset, i)))
      const mark = el('mark', null, rest.slice(i, i + q.length))
      frag.appendChild(mark)
      offset = i + q.length
      i = rest.toLowerCase().indexOf(q, offset)
    }
    frag.appendChild(document.createTextNode(rest.slice(offset)))
    node.appendChild(frag)
    return node
  }

  /* ------------------------------------------------ 设置面板 */

  function syncSettingsForm() {
    const s = state.settings
    $('setTheme').value = s.theme
    $('setSort').value = s.sortMode
    $('setCarry').checked = !!s.carryOver
    $('setCarryWin').value = String(s.carryOverWindowDays)
    $('setRemind').checked = !!s.reminderEnabled
    $('setAutostart').checked = !!s.launchAtLogin
    if ($('setTray')) $('setTray').checked = s.closeToTray !== false
    if ($('setAutoUpdate')) $('setAutoUpdate').checked = s.autoCheckUpdate !== false
    if ($('setSyncServer')) $('setSyncServer').checked = s.syncEnabled !== false
    $('dataPathText').textContent = `数据文件：${state.dataPath}`
    refreshSyncInfo()
  }

  /** 电脑端：显示同步服务地址，方便在手机上填写 */
  const refreshSyncInfo = guard(async () => {
    if (!api.syncInfo) return
    const info = await api.syncInfo()
    const box = $('syncUrlText')
    if (!box || !info) return
    const head = info.running ? '手机同步服务已开启' : info.enabled ? '手机同步服务未启动' : '手机同步服务已关闭'
    const urls = info.urls && info.urls.length ? info.urls.join('　或　') : '（没检测到局域网地址，确认已连 Wi-Fi）'
    const last = info.lastSyncAt
      ? `最近同步：${new Date(info.lastSyncAt).toLocaleString('zh-CN', { hour12: false })}（来自 ${info.lastSyncFrom || '手机'}）`
      : '还没有手机同步过'
    box.textContent = `${head}。在手机「设置 → 电脑地址」里填：${urls}　·　${last}`
  })

  /** 更新状态显示；下载完成后按钮自动变成「重启并安装」 */
  function renderUpdateStatus(s) {
    if (!s) return
    const box = $('updateStatusText')
    const btn = $('checkUpdateBtn')
    const label =
      {
        idle: '尚未检查',
        unconfigured: '尚未配置更新源',
        checking: s.attempt > 1 ? `正在检查…（第 ${s.attempt}/${s.attempts} 次，网络不太顺）` : '正在检查…',
        downloading: `正在下载新版本 v${s.version || ''}（${s.percent || 0}%）`,
        ready: `新版本 v${s.version} 已下载，重启后生效`,
        latest: '已是最新版本',
        error: `检查失败：${s.error || '未知错误'}`,
      }[s.state] || s.state
    if (box) {
      let text = `当前版本 v${s.current}　·　${label}`
      if (!s.supported) text += '　·　开发模式不支持自动更新'
      else if (s.state === 'unconfigured') {
        text += '（发布前需在 electron-builder.yml 填好 publish.owner / repo，重新打包后生效）'
      } else if (s.source) {
        text += `　·　更新源 ${s.source}`
      }
      box.textContent = text
    }
    if (btn) {
      const ready = s.state === 'ready'
      const blocked = !s.supported || s.state === 'unconfigured'
      btn.textContent = ready ? '重启并安装' : '检查更新'
      btn.dataset.mode = ready ? 'install' : 'check'
      btn.disabled = blocked && !ready
    }
    if (s.state === 'ready' && !state.updateReadyToasted) {
      state.updateReadyToasted = true
      toast(`新版本 v${s.version} 已下载，重启后生效`, 'ok')
    }
  }

  const saveSettings = guard(async (patch) => {
    const s = await api.saveSettings(patch)
    if (s) {
      applySettings(s)
      syncSettingsForm()
    }
  })

  function openSettings() {
    syncSettingsForm()
    $('settingsModal').hidden = false
  }

  /* ------------------------------------------------ 事件绑定 */

  function bindEvents() {
    // 新增任务
    const addTask = guard(async () => {
      const title = $('newTitle').value.trim()
      if (!title) {
        $('newTitle').focus()
        return
      }
      const payload = {
        date: state.date,
        title,
        note: $('newNote').value.trim(),
        priority: Number($('newPriority').value),
        type: $('newType').value,
        remindAt: $('newRemind').value || null,
        repeat: $('newRepeat').value,
      }
      const r = await api.addTask(payload)
      $('newTitle').value = ''
      $('newNote').value = ''
      $('newRemind').value = ''
      $('newRepeat').value = 'none'
      $('newPriority').value = '0'
      // 类型故意不清空：连着录几条同类任务时不用反复选（优先级/重复仍恢复默认）
      if (r) {
        applyDatePayload(r)
        renderAll()
        await Promise.all([refreshCalendar(), refreshStats()])
        renderAll()
      }
      $('newTitle').focus()
    })

    $('addBtn').addEventListener('click', addTask)
    $('newTitle').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        addTask()
      }
    })
    $('newNote').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        addTask()
      }
    })

    // 日期导航
    $('prevDay').addEventListener('click', () => goToDate(shiftKey(state.date, -1)))
    $('nextDay').addEventListener('click', () => goToDate(shiftKey(state.date, 1)))
    $('todayBtn').addEventListener('click', () => goToDate(state.today))

    const shiftMonth = (delta) => {
      let y = state.calYear
      let m = state.calMonth + delta
      if (m < 1) {
        m = 12
        y--
      } else if (m > 12) {
        m = 1
        y++
      }
      state.calYear = y
      state.calMonth = m
      refreshCalendar()
    }
    $('calPrev').addEventListener('click', () => shiftMonth(-1))
    $('calNext').addEventListener('click', () => shiftMonth(1))

    // 备忘
    $('memo').addEventListener('input', scheduleMemoSave)
    $('memo').addEventListener('blur', () => flushMemo())

    // 排序
    $('sortMode').addEventListener('change', async (e) => {
      await saveSettings({ sortMode: e.target.value })
      state.tasks.sort(taskComparator)
      renderTasks()
    })

    // 类型筛选（只影响显示，不动数据）
    if ($('typeFilter')) {
      $('typeFilter').addEventListener('change', (e) => {
        state.typeFilter = e.target.value
        renderTasks()
      })
    }

    // 手机同步完成后电脑这边要把界面刷新一遍
    if (api.onDataChanged) api.onDataChanged(() => reloadDate())

    // 清除已完成
    $('clearDoneBtn').addEventListener('click', guard(async () => {
      const done = state.tasks.filter((t) => t.done)
      if (!done.length) {
        toast('这一天没有已完成的任务')
        return
      }
      const btn = $('clearDoneBtn')
      // 同样是两步确认，批量删除更要防误触
      if (!btn.classList.contains('is-confirming')) {
        btn.classList.add('is-confirming')
        btn.textContent = `确认清除 ${done.length} 项？`
        setTimeout(() => {
          btn.classList.remove('is-confirming')
          btn.textContent = '清除已完成'
        }, 3000)
        return
      }
      btn.classList.remove('is-confirming')
      btn.textContent = '清除已完成'
      for (const t of done) await api.deleteTask(t.id, 'one')
      await reloadDate()
      toast(`已清除 ${done.length} 项`, 'ok')
    }))

    // 搜索
    const searchInput = $('searchInput')
    searchInput.addEventListener('input', () => {
      if (searchTimer) clearTimeout(searchTimer)
      searchTimer = setTimeout(() => runSearch(searchInput.value), 180)
    })
    searchInput.addEventListener('focus', () => {
      if (searchInput.value.trim()) runSearch(searchInput.value)
    })
    document.addEventListener('click', (e) => {
      if (!$('searchResults').hidden && !e.target.closest('.search-wrap')) $('searchResults').hidden = true
    })

    // 同步按钮：手机端真正发起同步；电脑端本身是服务端，点击显示状态与地址
    if ($('syncBtn')) {
      $('syncBtn').addEventListener('click', guard(async () => {
        if (api.syncNow) {
          toast('正在同步…')
          const r = await api.syncNow()
          if (r && r.ok) {
            const s = r.stat || {}
            await reloadDate()
            toast(`同步完成：新增 ${s.tasksAdded || 0} · 更新 ${s.tasksUpdated || 0} · 删除 ${s.tasksDeleted || 0}`, 'ok')
          } else {
            toast((r && r.error) || '同步失败', 'error')
          }
          return
        }
        if (api.syncInfo) {
          let info = await api.syncInfo()
          if (info && !info.running && api.syncRestart) info = await api.syncRestart()
          const url = info && info.urls && info.urls.length ? info.urls[0] : '未检测到局域网地址'
          const last = info && info.lastSyncAt
            ? `上次同步 ${new Date(info.lastSyncAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
            : '还没被手机同步过'
          toast(`电脑端即同步服务 · 手机填 ${url} · ${last}`)
        }
      }))
    }

    // 主题
    $('themeBtn').addEventListener('click', async () => {
      const order = ['auto', 'light', 'dark', 'galaxy']
      const next = order[(order.indexOf(state.settings.theme) + 1) % order.length]
      await saveSettings({ theme: next })
      toast(`主题：${{ auto: '跟随系统', light: '浅色', dark: '深色', galaxy: '星辰大海' }[next]}`)
    })

    // 设置
    $('settingsBtn').addEventListener('click', openSettings)
    $('settingsClose').addEventListener('click', () => {
      $('settingsModal').hidden = true
    })
    $('settingsModal').addEventListener('click', (e) => {
      if (e.target === $('settingsModal')) $('settingsModal').hidden = true
    })
    $('setTheme').addEventListener('change', (e) => saveSettings({ theme: e.target.value }))
    $('setSort').addEventListener('change', (e) => saveSettings({ sortMode: e.target.value }))
    $('setCarry').addEventListener('change', (e) => saveSettings({ carryOver: e.target.checked }))
    $('setCarryWin').addEventListener('change', (e) => saveSettings({ carryOverWindowDays: Number(e.target.value) }))
    $('setRemind').addEventListener('change', (e) => saveSettings({ reminderEnabled: e.target.checked }))
    $('setAutostart').addEventListener('change', (e) => saveSettings({ launchAtLogin: e.target.checked }))
    if ($('setTray')) $('setTray').addEventListener('change', (e) => saveSettings({ closeToTray: e.target.checked }))
    if ($('setAutoUpdate'))
      $('setAutoUpdate').addEventListener('change', (e) => saveSettings({ autoCheckUpdate: e.target.checked }))

    // 更新状态：按钮在「检查更新 / 重启并安装」之间切换
    if ($('checkUpdateBtn')) {
      $('checkUpdateBtn').addEventListener('click', guard(async () => {
        if ($('checkUpdateBtn').dataset.mode === 'install') {
          await api.installUpdate()
          return
        }
        if (!api.checkForUpdates) return
        const r = await api.checkForUpdates(true)
        if (r && r.ok === false) {
          if (r.reason === 'dev') toast('开发模式不支持自动更新，打包安装后才会生效')
          else if (r.reason === 'unconfigured') toast('还没配置更新源：发布前要填 publish.owner / repo')
        }
      }))
    }
    if (api.updateStatus) api.updateStatus().then(renderUpdateStatus)
    if (api.onUpdateStatus) api.onUpdateStatus(renderUpdateStatus)
    if ($('setSyncServer'))
      $('setSyncServer').addEventListener('change', async (e) => {
        await saveSettings({ syncEnabled: e.target.checked })
        refreshSyncInfo()
      })

    // 数据
    $('exportBtn').addEventListener('click', guard(async () => {
      const r = await api.exportData()
      if (r && !r.canceled) toast('备份已导出', 'ok')
    }))
    const doImport = guard(async () => {
      const r = await api.importData()
      if (r && !r.canceled) {
        toast(`导入完成：${r.summary.tasks} 条任务 / ${r.summary.memos} 条备忘`, 'ok')
        await reloadDate()
        await refreshCalendar()
      }
    })
    $('importBtn').addEventListener('click', doImport)
    api.onRequestImport(doImport)
    $('revealBtn').addEventListener('click', () => api.revealData())

    // 主进程推送
    api.onDayChanged(guard(async (p) => {
      const wasToday = state.date === state.today
      state.today = p.today
      if (wasToday) {
        await reloadDate()
      } else {
        await Promise.all([refreshCalendar(), refreshStats()])
        renderAll()
      }
      if (p.carried > 0) showCarryBanner(p.carried)
    }))

    api.onRemindersFired(async (p) => {
      for (const id of p.ids) state.firedIds.add(id)
      renderTasks()
    })

    api.onFocusDate(guard(async (p) => {
      if (p && p.date) await goToDate(p.date)
    }))

    // 托盘菜单「新建任务…」→ 聚焦输入框（移动端没有这个能力，做了存在性判断）
    if (api.onFocusNewTask) {
      api.onFocusNewTask(() => {
        const t = $('newTitle')
        if (t) {
          t.focus()
          t.select()
        }
      })
    }

    // 快捷键
    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        $('newTitle').focus()
      } else if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        $('searchInput').focus()
        $('searchInput').select()
      } else if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()
        flushMemo()
        toast('已保存', 'ok')
      } else if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault()
        goToDate(shiftKey(state.date, -1))
      } else if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault()
        goToDate(shiftKey(state.date, 1))
      } else if (e.key === 'Escape') {
        if (!$('settingsModal').hidden) $('settingsModal').hidden = true
        else if (!$('searchResults').hidden) $('searchResults').hidden = true
        else if (state.editingId) {
          state.editingId = null
          renderTasks()
        }
      }
    })

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (state.settings.theme === 'auto') applySettings(state.settings)
    })

    window.addEventListener('beforeunload', () => flushMemo())
  }

  init().catch((err) => {
    console.error('初始化失败', err)
    const box = document.createElement('div')
    box.style.cssText = 'padding:24px;font-size:14px;color:#e5484d'
    box.textContent = '初始化失败：' + ((err && err.message) || err)
    document.body.appendChild(box)
  })
})()
