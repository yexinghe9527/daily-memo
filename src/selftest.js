'use strict'

/**
 * 数据层自检：不依赖 Electron，纯 Node 可跑（node src/selftest.js）。
 * --smoke 模式下由主进程调用，用一次性目录验证增删改查、重复任务、顺延、统计、导入导出。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert')

const { Store, todayKey, shiftKey, toDateTimeKey } = require('./store')

function runSelfTest(filePath) {
  const file = filePath || path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'daily-memo-st-')), 'data.json')
  const pass = []
  const t = (name, fn) => {
    fn()
    pass.push(name)
  }

  const s = new Store(file)
  const today = todayKey()
  const yesterday = shiftKey(today, -1)
  const tomorrow = shiftKey(today, 1)

  t('空库启动', () => {
    assert.strictEqual(s.data.tasks.length, 0)
    assert.strictEqual(s.data.version, 1)
  })

  t('新增任务', () => {
    const a = s.addTask({ date: today, title: '  写周报  ', priority: 2, remindAt: '9:5' })
    assert.strictEqual(a.title, '写周报', '标题应被 trim')
    assert.strictEqual(a.priority, 2)
    assert.strictEqual(a.remindAt, `${today}T09:05`, '旧式纯时间应补全为完整日期时间')
    assert.strictEqual(s.listByDate(today).length, 1)
  })

  t('非法输入被兜住', () => {
    const b = s.addTask({ date: 'not-a-date', title: '', remindAt: '99:99' })
    assert.strictEqual(b.date, today, '非法日期应回落到今天')
    assert.strictEqual(b.title, '未命名任务')
    assert.strictEqual(b.remindAt, null)
    s.deleteTask(b.id)
  })

  t('勾选与取消', () => {
    const list = s.listByDate(today)
    const id = list[0].id
    assert.strictEqual(s.toggleTask(id).done, true)
    assert.strictEqual(s.listByDate(today)[0].done, true, '已完成的排到最后')
    assert.strictEqual(s.toggleTask(id).done, false)
  })

  t('落盘后可重新读回', () => {
    const again = new Store(file)
    assert.strictEqual(again.data.tasks.length, 1)
    assert.strictEqual(again.data.tasks[0].title, '写周报')
  })

  t('备忘读写与清空', () => {
    s.setMemo(today, '今天状态不错')
    assert.strictEqual(new Store(file).getMemo(today).text, '今天状态不错')
    s.setMemo(today, '   ')
    assert.strictEqual(new Store(file).getMemo(today).text, '', '纯空白应清空备忘')
    s.setMemo(today, '再来一次')
  })

  t('每日重复任务按天懒生成', () => {
    s.addTask({ date: today, title: '喝水', repeat: 'daily' })
    s.materialize(today)
    assert.strictEqual(s.listByDate(today).filter((x) => x.title === '喝水').length, 1, '当天不应重复生成')
    s.materialize(tomorrow)
    assert.strictEqual(s.listByDate(tomorrow).filter((x) => x.title === '喝水').length, 1)
    s.materialize(tomorrow)
    assert.strictEqual(s.listByDate(tomorrow).filter((x) => x.title === '喝水').length, 1, '重复调用仍只有一条')
  })

  t('重复任务起始日之前不生成', () => {
    const far = shiftKey(today, -3)
    assert.strictEqual(s.listByDate(far).filter((x) => x.title === '喝水').length, 0)
  })

  t('删除重复任务某一天会留墓碑', () => {
    const inst = s.listByDate(tomorrow).find((x) => x.title === '喝水')
    s.deleteTask(inst.id, 'one')
    s.materialize(tomorrow)
    assert.strictEqual(s.listByDate(tomorrow).filter((x) => x.title === '喝水').length, 0, '删掉的那天不该复活')
    s.materialize(shiftKey(today, 2))
    assert.strictEqual(s.listByDate(shiftKey(today, 2)).filter((x) => x.title === '喝水').length, 1, '不影响别的日期')
  })

  t('重复任务改标题可同步未来实例', () => {
    // 注意：明天那条已被上一条用例删掉并留了墓碑，这里用后天/大后天验证
    const day2 = shiftKey(today, 2)
    const day3 = shiftKey(today, 3)
    s.materialize(day2)
    s.materialize(day3)
    const inst = s.listByDate(day2).find((x) => x.title === '喝水')
    assert.ok(inst, '后天应有重复实例')
    s.updateTask(inst.id, { title: '喝水 2L' }, 'future')
    assert.strictEqual(s.getTask(inst.id).title, '喝水 2L', '当条应被改名')
    const later = s.listByDate(day3).find((x) => x.groupId === inst.groupId)
    assert.ok(later, '大后天应有同组实例')
    assert.strictEqual(later.title, '喝水 2L', '未来实例应同步改名')
  })

  t('未完成顺延到今天并记录来源', () => {
    const old = s.addTask({ date: yesterday, title: '没做完的事' })
    const moved = s.carryOver(today)
    assert.ok(moved >= 1, '至少应顺延一条')
    const after = s.getTask(old.id)
    assert.strictEqual(after.date, today)
    assert.strictEqual(after.carriedFrom, yesterday)
  })

  t('顺延窗口之外的旧任务保持原位', () => {
    const ancient = s.addTask({ date: shiftKey(today, -60), title: '很久以前' })
    s.carryOver(today)
    assert.strictEqual(s.getTask(ancient.id).date, shiftKey(today, -60))
  })

  t('关闭顺延开关后不再搬动', () => {
    s.data.settings.carryOver = false
    const stale = s.addTask({ date: yesterday, title: '留着不动' })
    s.carryOver(today)
    assert.strictEqual(s.getTask(stale.id).date, yesterday)
    s.data.settings.carryOver = true
  })

  t('已完成的任务不会被顺延', () => {
    const d = s.addTask({ date: yesterday, title: '做完了' })
    s.setDone(d.id, true)
    s.carryOver(today)
    assert.strictEqual(s.getTask(d.id).date, yesterday)
  })

  t('重复任务不参与顺延（避免堆积）', () => {
    const g = Object.values(s.data.repeatGroups)[0]
    const inst = s.data.tasks.find((x) => x.groupId === g.id && x.date === shiftKey(today, 2))
    inst.date = yesterday
    inst.done = false
    s.carryOver(today)
    assert.strictEqual(s.getTask(inst.id).date, yesterday)
  })

  t('手动排序', () => {
    const list = s.listByDate(today)
    const ids = list.map((x) => x.id).reverse()
    s.reorder(today, ids)
    assert.deepStrictEqual(
      s.listByDate(today).map((x) => x.id),
      ids
    )
    assert.strictEqual(s.data.settings.sortMode, 'manual')
  })

  t('统计口径正确', () => {
    s.addTask({ date: today, title: '统计A' })
    const st = s.stats(today)
    assert.strictEqual(st.today.total, s.listByDate(today).length)
    assert.strictEqual(st.week.length, 7)
    assert.ok(st.totalTasks >= st.totalDone)
    assert.ok(Number.isInteger(st.streak))
  })

  t('日历月视图覆盖整月', () => {
    const d = new Date()
    const m = s.monthOverview(d.getFullYear(), d.getMonth() + 1)
    const days = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
    assert.strictEqual(Object.keys(m).length, days)
  })

  t('搜索命中标题与备注', () => {
    s.addTask({ date: today, title: '搜索目标甲', note: '关键字乙' })
    assert.ok(s.search('目标甲').tasks.length >= 1)
    assert.ok(s.search('关键字乙').tasks.length >= 1)
    assert.strictEqual(s.search('').tasks.length, 0)
    assert.ok(s.search('再来一次').memos.length >= 1, '备忘也应可搜')
  })

  t('提醒：到点触发且只弹一次', () => {
    const now = new Date()
    const past = toDateTimeKey(new Date(now.getTime() - 60 * 60 * 1000))
    const r = s.addTask({ date: today, title: '到点提醒', remindAt: past })
    assert.ok(s.dueReminders(now).some((x) => x.id === r.id), '到点应触发')
    s.markReminded(s.dueReminders(now).map((x) => x.id))
    assert.ok(!s.dueReminders(now).some((x) => x.id === r.id), '已提醒过的不该重复弹')
    s.setDone(r.id, true)
  })

  t('提醒：改成将来不触发，改回过去重新触发', () => {
    const now = new Date()
    const r = s.addTask({
      date: today,
      title: '改时间',
      remindAt: toDateTimeKey(new Date(now.getTime() + 30 * 60 * 1000)),
    })
    assert.ok(!s.dueReminders(now).some((x) => x.id === r.id), '还没到点不该触发')
    s.updateTask(r.id, { remindAt: toDateTimeKey(new Date(now.getTime() - 5 * 60 * 1000)) })
    assert.ok(s.dueReminders(now).some((x) => x.id === r.id), '到点应触发')
    s.markReminded(s.dueReminders(now).map((x) => x.id))
    assert.ok(!s.dueReminders(now).some((x) => x.id === r.id))
    // 再改一次时间 → 应重新武装
    s.updateTask(r.id, { remindAt: toDateTimeKey(new Date(now.getTime() - 3 * 60 * 1000)) })
    assert.ok(s.dueReminders(now).some((x) => x.id === r.id), '改了时间应重新武装')
    s.deleteTask(r.id)
  })

  t('提醒：错过超过宽限期不再补弹', () => {
    const now = new Date()
    const r = s.addTask({
      date: today,
      title: '两天前错过',
      remindAt: toDateTimeKey(new Date(now.getTime() - 48 * 3600 * 1000)),
    })
    assert.ok(!s.dueReminders(now).some((x) => x.id === r.id), '超过宽限期不该补弹')
    s.deleteTask(r.id)
  })

  t('提醒：重复任务把时间套到各自日期', () => {
    const g = s.addTask({ date: today, title: '每天喝水提醒', repeat: 'daily', remindAt: `${today}T08:30` })
    const day2 = shiftKey(today, 1)
    s.materialize(day2)
    const inst = s.listByDate(day2).find((x) => x.title === '每天喝水提醒')
    assert.ok(inst, '次日应有重复实例')
    assert.strictEqual(inst.remindAt, `${day2}T08:30`, '时间应套用到实例自己的日期')
    assert.strictEqual(s.getTask(g.id).remindAt, `${today}T08:30`)
    s.deleteTask(g.id, 'future')
  })

  t('旧数据迁移：纯时间补全为任务当天并保留已提醒标记', () => {
    const s6 = new Store(path.join(path.dirname(file), 'legacy.json'))
    s6.importPayload({
      tasks: [{ id: 'legacy1', title: '旧任务', date: today, remindAt: '11:45', remindFiredOn: today }],
    })
    const t1 = s6.getTask('legacy1')
    assert.strictEqual(t1.remindAt, `${today}T11:45`, '旧式 HH:mm 应补全为完整日期时间')
    assert.strictEqual(t1.remindFired, `${today}T11:45`, '旧的「已提醒」标记应迁移过来')
  })

  t('提醒开关关闭后不再触发', () => {
    s.data.settings.reminderEnabled = false
    s.addTask({ date: today, title: '不该提醒', remindAt: `${today}T00:01` })
    assert.strictEqual(s.dueReminders(new Date()).length, 0)
    s.data.settings.reminderEnabled = true
  })

  t('任务类型：默认未分类、非法值归零', () => {
    const a = s.addTask({ date: today, title: '工作的事', type: 'work' })
    assert.strictEqual(a.type, 'work')
    const b = s.addTask({ date: today, title: '乱写的类型', type: 'nonsense' })
    assert.strictEqual(b.type, 'none')
    assert.strictEqual(s.updateTask(a.id, { type: 'personal' }).type, 'personal')
  })

  t('同步合并：较新的改动胜出且两端收敛', () => {
    const A = new Store(path.join(path.dirname(file), 'sync-a.json'))
    const B = new Store(path.join(path.dirname(file), 'sync-b.json'))
    const t1 = A.addTask({ date: today, title: '原标题' })
    B.mergeFrom(A.syncPayload())
    assert.strictEqual(B.getTask(t1.id).title, '原标题', '应能合到对端')
    A.updateTask(t1.id, { title: 'A 改的' })
    B.updateTask(t1.id, { title: 'B 改的' })
    B.getTask(t1.id).updatedAt = Date.now() + 5000 // 让 B 的改动更晚
    B.save()

    A.mergeFrom(B.syncPayload())
    assert.strictEqual(A.getTask(t1.id).title, 'B 改的', '较新的改动应胜出')
    B.mergeFrom(A.syncPayload())
    assert.strictEqual(B.getTask(t1.id).title, 'B 改的', '两端应收敛到一致')
  })

  t('同步合并：删除会传播且不会被合并回来', () => {
    const A = new Store(path.join(path.dirname(file), 'sync-c.json'))
    const B = new Store(path.join(path.dirname(file), 'sync-d.json'))
    const t1 = A.addTask({ date: today, title: '待删除' })
    B.mergeFrom(A.syncPayload())
    assert.ok(B.getTask(t1.id), '先同步过去')

    A.deleteTask(t1.id, 'one')
    B.mergeFrom(A.syncPayload())
    assert.strictEqual(B.getTask(t1.id), null, '删除应传播到另一端')

    A.mergeFrom(B.syncPayload())
    assert.strictEqual(A.getTask(t1.id), null, '删除不应被重新合并回来')
  })

  t('同步合并：清空的备忘也会传播', () => {
    const A = new Store(path.join(path.dirname(file), 'sync-e.json'))
    const B = new Store(path.join(path.dirname(file), 'sync-f.json'))
    A.setMemo(today, '备忘内容')
    B.mergeFrom(A.syncPayload())
    assert.strictEqual(B.getMemo(today).text, '备忘内容')
    A.setMemo(today, '   ')
    B.mergeFrom(A.syncPayload())
    assert.strictEqual(B.getMemo(today).text, '', '清空应传播过去')
  })

  t('同步合并：重复任务的类型也带得过去', () => {
    const A = new Store(path.join(path.dirname(file), 'sync-g.json'))
    const B = new Store(path.join(path.dirname(file), 'sync-h.json'))
    const g = A.addTask({ date: today, title: '每天站会', repeat: 'daily', type: 'work' })
    B.mergeFrom(A.syncPayload())
    const day2 = shiftKey(today, 1)
    B.materialize(day2)
    const inst = B.listByDate(day2).find((x) => x.title === '每天站会')
    assert.ok(inst, '对端应能生成重复实例')
    assert.strictEqual(inst.type, 'work', '类型应跟着重复规则走')
    A.deleteTask(g.id, 'future')
  })

  t('导出导入往返一致', () => {
    const payload = JSON.parse(JSON.stringify(s.exportPayload()))
    const count = s.data.tasks.length
    const fresh = new Store(path.join(path.dirname(file), 'fresh.json'))
    fresh.importPayload(payload)
    assert.strictEqual(fresh.data.tasks.length, count)
    assert.deepStrictEqual(
      fresh.data.tasks.map((x) => x.id).sort(),
      s.data.tasks.map((x) => x.id).sort()
    )
  })

  t('导入非法文件被拒绝', () => {
    const fresh = new Store(path.join(path.dirname(file), 'fresh2.json'))
    assert.throws(() => fresh.importPayload({ hello: 'world' }), /格式不对/)
    assert.throws(() => fresh.importPayload(null), /格式不对/)
  })

  t('数据文件损坏时留档并恢复可用', () => {
    const broken = path.join(path.dirname(file), 'broken.json')
    fs.writeFileSync(broken, '{ this is not json')
    const recovered = new Store(broken)
    assert.strictEqual(recovered.data.tasks.length, 0)
    assert.ok(recovered.data.meta.recoveredFrom, '应记录损坏文件留档路径')
    assert.ok(fs.existsSync(recovered.data.meta.recoveredFrom))
  })

  t('原子写入不留下临时文件', () => {
    s.save()
    const leftovers = fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp'))
    assert.strictEqual(leftovers.length, 0)
  })

  return `通过 ${pass.length} 项：${pass.join('、')}`
}

if (require.main === module) {
  try {
    const detail = runSelfTest()
    process.stdout.write('SELFTEST OK\n' + detail + '\n')
    process.exit(0)
  } catch (err) {
    process.stdout.write('SELFTEST FAILED\n' + (err && err.stack) + '\n')
    process.exit(1)
  }
}

module.exports = { runSelfTest }
