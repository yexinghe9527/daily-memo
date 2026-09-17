'use strict'

/**
 * 预加载脚本：在 contextIsolation + sandbox 下只暴露一组白名单方法给界面。
 * 界面拿不到 Node / ipcRenderer / require，只能调用这里列出的能力。
 */

const { contextBridge, ipcRenderer } = require('electron')

function subscribe(channel, cb) {
  const handler = (_event, payload) => {
    try {
      cb(payload)
    } catch (err) {
      console.error('[preload] 订阅回调异常', channel, err)
    }
  }
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('memoApi', {
  bootstrap: (payload) => ipcRenderer.invoke('app:bootstrap', payload || {}),
  loadDate: (payload) => ipcRenderer.invoke('date:load', payload || {}),
  addTask: (payload) => ipcRenderer.invoke('task:add', payload || {}),
  updateTask: (payload) => ipcRenderer.invoke('task:update', payload || {}),
  toggleTask: (id) => ipcRenderer.invoke('task:toggle', { id }),
  deleteTask: (id, scope) => ipcRenderer.invoke('task:delete', { id, scope: scope || 'one' }),
  reorder: (payload) => ipcRenderer.invoke('task:reorder', payload || {}),
  setMemo: (payload) => ipcRenderer.invoke('memo:set', payload || {}),
  saveSettings: (patch) => ipcRenderer.invoke('settings:update', patch || {}),
  getStats: (date) => ipcRenderer.invoke('stats:get', { date }),
  syncInfo: () => ipcRenderer.invoke('sync:info'),
  syncRestart: () => ipcRenderer.invoke('sync:restart'),
  updateStatus: () => ipcRenderer.invoke('update:status'),
  checkForUpdates: (manual) => ipcRenderer.invoke('update:check', { manual: !!manual }),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  getCalendar: (year, month) => ipcRenderer.invoke('calendar:get', { year, month }),
  search: (query) => ipcRenderer.invoke('search', { query }),
  exportData: () => ipcRenderer.invoke('data:export'),
  importData: () => ipcRenderer.invoke('data:import'),
  revealData: () => ipcRenderer.invoke('data:reveal'),
  ready: (info) => ipcRenderer.send('app:ready', info),

  onDayChanged: (cb) => subscribe('day:changed', cb),
  onRemindersFired: (cb) => subscribe('reminders:fired', cb),
  onFocusDate: (cb) => subscribe('focus:date', cb),
  onFocusNewTask: (cb) => subscribe('focus:new-task', cb),
  onDataChanged: (cb) => subscribe('data:changed', cb),
  onUpdateStatus: (cb) => subscribe('update:status', cb),
  onRequestImport: (cb) => subscribe('menu:request-import', cb),
})
