'use strict'

/**
 * 把 tools/demo-dataset.js 的虚构数据灌进一个真实的 Store 实例。
 *
 * 用的是真实的 src/store.js，所以产出的 data.json 一定符合当前 schema，
 * 不会出现「截图里的字段和真机不一致」这种假象。
 *
 * 直接运行（作为脚本）：
 *   node tools/make-demo-data.js [输出目录]
 * 默认输出到系统临时目录下的 xinghelu-demo/。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Store, todayKey, shiftKey } = require('../src/store')
const dataset = require('./demo-dataset')

/** 把数据集写进 store（桌面端的真实数据层） */
function seed(store) {
  const today = todayKey()
  const keyOf = (offset) => shiftKey(today, offset)

  Object.assign(store.data.settings, dataset.settings)

  const byDay = new Map()
  for (const item of dataset.tasks) {
    const date = keyOf(item.day)
    const task = store.addTask({
      title: item.title,
      note: item.note,
      date,
      type: item.type,
      priority: item.priority,
      remindAt: item.remindTime ? `${date}T${item.remindTime}` : undefined,
      repeat: item.repeat,
    })
    if (item.done) store.setDone(task.id, true)
    byDay.set(date, (byDay.get(date) || 0) + 1)
  }

  for (const [offset, text] of Object.entries(dataset.memos)) {
    store.setMemo(keyOf(Number(offset)), text)
  }

  store.save()
  return { today, byDay }
}

module.exports = { seed }

/* ------------------------------------------------------------------ */

if (require.main === module) {
  const outDir = process.argv[2] || path.join(os.tmpdir(), 'xinghelu-demo')
  fs.mkdirSync(outDir, { recursive: true })
  const file = path.join(outDir, 'data.json')
  if (fs.existsSync(file)) fs.rmSync(file)

  const store = new Store(file)
  const { today } = seed(store)
  const todayTasks = store.listByDate(today)

  console.log(
    JSON.stringify(
      {
        file,
        today,
        tasks: store.data.tasks.length,
        todayTotal: todayTasks.length,
        todayDone: todayTasks.filter((t) => t.done).length,
        byType: store.data.tasks.reduce((acc, t) => {
          acc[t.type] = (acc[t.type] || 0) + 1
          return acc
        }, {}),
        hasMemo: !!store.getMemo(today),
      },
      null,
      2
    )
  )
  console.log(`\n演示数据已写入：${file}`)
  console.log('注：全部为虚构内容，与任何真实用户数据无关。')
}
