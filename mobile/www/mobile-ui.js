'use strict'

/**
 * 星河录 · 移动端交互层
 * 只负责「手机才需要的那层壳」：底部抽屉的开合、搜索栏、状态栏配色、
 * 以及关掉触屏上用不到的拖拽。业务逻辑仍全部在 app.js 里，此处不碰数据。
 */

;(function () {
  const $ = (id) => document.getElementById(id)

  /* ---------------- 抽屉开合 ---------------- */

  function openSheet(id) {
    const el = $(id)
    if (!el || !el.hidden) return
    el.classList.remove('is-closing')
    el.hidden = false
    // 压入一条历史记录，这样安卓返回键能先关抽屉而不是直接退出应用
    try {
      history.pushState({ sheet: id }, '')
    } catch (_) {
      /* 某些环境不允许 pushState，忽略 */
    }
    if (id === 'sheetComposer') {
      setTimeout(() => {
        const t = $('newTitle')
        if (t) t.focus()
      }, 140)
    }
  }

  function closeSheet(id) {
    const el = $(id)
    if (!el || el.hidden) return
    el.classList.add('is-closing')
    setTimeout(() => {
      el.hidden = true
      el.classList.remove('is-closing')
    }, 170)
  }

  /** 由界面发起的关闭：优先走 history.back()，让硬件返回键与按钮行为一致 */
  function requestClose(id) {
    const el = $(id)
    if (!el || el.hidden) return
    let sameState = false
    try {
      sameState = !!(history.state && history.state.sheet === id)
    } catch (_) {
      sameState = false
    }
    if (sameState) history.back()
    else closeSheet(id)
  }

  window.addEventListener('popstate', () => {
    const open = document.querySelector('.m-sheet:not([hidden])')
    if (open) closeSheet(open.id)
  })

  /* ---------------- 状态栏配色跟随主题 ---------------- */

  const THEME_COLORS = { light: '#eef1f8', dark: '#0d111c', galaxy: '#070b1c' }

  function syncThemeColor() {
    const theme = document.documentElement.dataset.theme
    let meta = document.querySelector('meta[name="theme-color"]')
    if (!meta) {
      meta = document.createElement('meta')
      meta.name = 'theme-color'
      document.head.appendChild(meta)
    }
    meta.content = THEME_COLORS[theme] || THEME_COLORS.light
  }

  /** 同步结果的即时提示，比只改一行小字更容易被看到 */
  function toast(message, kind) {
    const t = document.getElementById('toast')
    if (!t) return
    t.textContent = message
    t.className = 'toast' + (kind ? ` is-${kind}` : '')
    t.hidden = false
    clearTimeout(toast._timer)
    toast._timer = setTimeout(() => {
      t.hidden = true
    }, 3600)
  }

  /* ---------------- 绑定 ---------------- */

  function bind() {
    const openers = [
      ['openComposer', 'sheetComposer'],
      ['openCalendar', 'sheetCalendar'],
      ['openMemo', 'sheetMemo'],
    ]
    for (const [btnId, sheetId] of openers) {
      const btn = $(btnId)
      if (btn) btn.addEventListener('click', () => openSheet(sheetId))
    }

    document.querySelectorAll('[data-close]').forEach((node) => {
      node.addEventListener('click', () => requestClose(node.dataset.close))
    })

    // 添加完任务后自动收起抽屉（任务本身由 app.js 处理）
    const addBtn = $('addBtn')
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        setTimeout(() => {
          const input = $('newTitle')
          if (input && input.value.trim()) requestClose('sheetComposer')
        }, 80)
      })
    }

    // 搜索栏展开/收起
    const searchToggle = $('searchToggle')
    const searchBar = $('mSearchBar')
    if (searchToggle && searchBar) {
      searchToggle.addEventListener('click', () => {
        searchBar.hidden = !searchBar.hidden
        if (!searchBar.hidden) setTimeout(() => $('searchInput') && $('searchInput').focus(), 60)
      })
    }

    // 与电脑同步（同一 Wi-Fi 下直连）
    const syncBtn = $('syncNowBtn')
    const syncInput = $('syncServerInput')
    const syncText = $('syncStatusText')
    if (syncBtn && window.memoApi && window.memoApi.syncNow) {
      const showStatus = async (extra) => {
        if (!syncText) return
        const st = window.memoApi.syncStatus ? await window.memoApi.syncStatus() : null
        if (!st) return
        const last = st.lastSyncAt
          ? `上次同步 ${new Date(st.lastSyncAt).toLocaleString('zh-CN', { hour12: false })}`
          : '还没同步过'
        syncText.textContent = `${extra ? extra + '　·　' : ''}本机 ${st.tasks} 条任务　·　${last}`
      }
      if (syncInput && window.memoApi.syncStatus) {
        window.memoApi.syncStatus().then((st) => {
          if (st && st.server) syncInput.value = st.server
        })
      }
      syncBtn.addEventListener('click', async () => {
        if (syncInput) await window.memoApi.saveSettings({ syncServer: syncInput.value.trim() })
        syncBtn.disabled = true
        syncBtn.textContent = '正在同步…'
        if (syncText) syncText.textContent = '正在连接电脑…'
        const r = await window.memoApi.syncNow()
        syncBtn.disabled = false
        syncBtn.textContent = '立即与电脑同步'
        if (r && r.ok) {
          const s = r.stat || {}
          const msg = `同步完成：新增 ${s.tasksAdded || 0} · 更新 ${s.tasksUpdated || 0} · 删除 ${s.tasksDeleted || 0}`
          await showStatus(msg)
          toast(msg, 'ok')
        } else {
          const msg = (r && r.error) || '同步失败'
          if (syncText) syncText.textContent = msg
          toast(msg, 'error')
        }
      })
      showStatus('')
    }

    // 触屏上不需要拖拽排序，且 draggable 会干扰纵向滚动
    const taskList = $('taskList')
    if (taskList) {
      const stripDraggable = () => {
        taskList.querySelectorAll('.task-item[draggable="true"]').forEach((n) => n.removeAttribute('draggable'))
      }
      stripDraggable()
      new MutationObserver(stripDraggable).observe(taskList, { childList: true, subtree: true })
    }

    // app.js 初始化时会聚焦 newTitle，但抽屉是关着的，这里收回焦点避免误弹键盘
    setTimeout(() => {
      const t = $('newTitle')
      if (t && document.activeElement === t) t.blur()
    }, 400)

    // 主题变化 → 同步状态栏
    syncThemeColor()
    new MutationObserver(syncThemeColor).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind)
  else bind()
})()
