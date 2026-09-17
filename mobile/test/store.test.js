'use strict'

/**
 * 移动端数据层移植自测（纯 Node，无需浏览器）：
 * 验证浏览器版 store.js 的业务逻辑与桌面版一致、且 localStorage 持久化/损坏留档正常。
 * 用法：node mobile/test/store.test.js
 */

const path = require('node:path')
const assert = require('node:assert')

require(path.join(__dirname, '..', 'www', 'store.js'))
const { XingheStore, XingheUtils } = globalThis
const { todayKey, shiftKey, toDateTimeKey } = XingheUtils

function mockStorage() {
  const m = {}
  const keys = []
  return {
    getItem: (k) => (k in m ? m[k] : null),
    setItem: (k, v) => {
      if (!(k in m)) keys.push(k)
      m[k] = String(v)
    },
    removeItem: (k) => {
      delete m[k]
      const i = keys.indexOf(k)
      if (i >= 0) keys.splice(i, 1)
    },
    key: (i) => (i < keys.length ? keys[i] : null),
    get length() {
      return keys.length
    },
  }
}

const pass = []
function t(name, fn) {
  fn()
  pass.push(name)
}

const storage = mockStorage()
const today = todayKey()
const s = new XingheStore(storage)

t('空库启动', () => assert.strictEqual(s.data.tasks.length, 0))

t('新增任务 + 字段校验', () => {
  const a = s.addTask({ date: today, title: '  写周报  ', priority: 2, remindAt: '9:5' })
  assert.strictEqual(a.title, '写周报')
  assert.strictEqual(a.remindAt, `${today}T09:05`, '旧式纯时间应补全为完整日期时间')
  assert.strictEqual(s.listByDate(today).length, 1)
})

t('持久化：新实例读回', () => {
  const s2 = new XingheStore(storage)
  assert.strictEqual(s2.data.tasks.length, 1)
  assert.strictEqual(s2.data.tasks[0].title, '写周报')
})

t('勾选 / 取消 / 统计', () => {
  const id = s.listByDate(today)[0].id
  s.toggleTask(id)
  assert.strictEqual(s.stats(today).today.done, 1)
  s.toggleTask(id)
})

t('重复任务懒生成 + 删除留墓碑', () => {
  s.addTask({ date: today, title: '喝水', repeat: 'daily' })
  const tomorrow = shiftKey(today, 1)
  s.materialize(tomorrow)
  assert.strictEqual(s.listByDate(tomorrow).filter((x) => x.title === '喝水').length, 1)
  const inst = s.listByDate(tomorrow).find((x) => x.title === '喝水')
  s.deleteTask(inst.id, 'one')
  s.materialize(tomorrow)
  assert.strictEqual(s.listByDate(tomorrow).filter((x) => x.title === '喝水').length, 0)
})

t('未完成顺延', () => {
  const y = shiftKey(today, -1)
  const old = s.addTask({ date: y, title: '没做完' })
  const moved = s.carryOver(today)
  assert.ok(moved >= 1)
  assert.strictEqual(s.getTask(old.id).date, today)
})

t('备忘 + 搜索', () => {
  s.setMemo(today, '今天状态不错')
  assert.ok(s.search('状态不错').memos.length >= 1)
})

t('导出导入往返一致', () => {
  const payload = JSON.parse(JSON.stringify(s.exportPayload()))
  const s3 = new XingheStore(mockStorage())
  s3.importPayload(payload)
  assert.strictEqual(s3.data.tasks.length, s.data.tasks.length)
})

t('损坏数据留档并恢复', () => {
  const st = mockStorage()
  st.setItem('xinghelu.data.v1', '{ not json')
  const s4 = new XingheStore(st)
  assert.strictEqual(s4.data.tasks.length, 0)
  assert.ok(s4.data.meta.recoveredFrom)
})

t('提醒：到点触发、只弹一次、改时间重新武装', () => {
  const now = new Date()
  const r = s.addTask({
    date: today,
    title: '手机到点提醒',
    remindAt: toDateTimeKey(new Date(now.getTime() - 60 * 60 * 1000)),
  })
  assert.ok(s.dueReminders(now).some((x) => x.id === r.id), '到点应触发')
  s.markReminded(s.dueReminders(now).map((x) => x.id))
  assert.ok(!s.dueReminders(now).some((x) => x.id === r.id), '已提醒过的不该重复弹')
  s.updateTask(r.id, { remindAt: toDateTimeKey(new Date(now.getTime() - 2 * 60 * 1000)) })
  assert.ok(s.dueReminders(now).some((x) => x.id === r.id), '改了时间应重新武装')
  s.deleteTask(r.id)
})

t('提醒：重复任务把时间套到各自日期', () => {
  const g = s.addTask({ date: today, title: '手机每天提醒', repeat: 'daily', remindAt: `${today}T08:30` })
  const day2 = shiftKey(today, 1)
  s.materialize(day2)
  const inst = s.listByDate(day2).find((x) => x.title === '手机每天提醒')
  assert.ok(inst, '次日应有重复实例')
  assert.strictEqual(inst.remindAt, `${day2}T08:30`)
  s.deleteTask(g.id, 'future')
})

process.stdout.write(`MOBILE STORE OK 通过 ${pass.length} 项：${pass.join('、')}\n`)
