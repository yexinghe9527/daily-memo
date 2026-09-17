'use strict'

/**
 * 同步端到端测试：直接请求电脑端已启动的同步服务，验证推送 / 拉取 / 墓碑删除。
 * 用法：node tools/test-sync.js [http://127.0.0.1:8765]
 * 测试任务用 2099-01-01 这种远期日期并自行删除，不影响日常视图。
 */

const http = require('node:http')

const base = process.argv[2] || 'http://127.0.0.1:8765'

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const u = new URL(path, base)
    const r = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname,
        method,
        headers: data
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
          : {},
      },
      (res) => {
        let buf = ''
        res.on('data', (c) => (buf += c))
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(buf || '{}') })
          } catch (_) {
            resolve({ status: res.statusCode, raw: buf })
          }
        })
      }
    )
    r.on('error', reject)
    if (data) r.write(data)
    r.end()
  })
}

const empty = { schema: 1, tasks: [], memos: {}, repeatGroups: {}, tombstones: {} }

;(async () => {
  const id = `t_synctest_${Date.now()}`
  const lines = []
  let failed = 0
  const check = (name, cond, detail) => {
    if (cond) lines.push(`[PASS] ${name}${detail ? ' -> ' + detail : ''}`)
    else {
      failed++
      lines.push(`[FAIL] ${name}${detail ? ' -> ' + detail : ''}`)
    }
  }

  const ping = await req('GET', '/api/ping')
  check('同步服务可达', ping.status === 200 && ping.json && ping.json.ok === true, `现有任务 ${ping.json && ping.json.tasks}`)

  const now = Date.now()
  const task = {
    id,
    title: '同步测试任务',
    note: '',
    date: '2099-01-01',
    done: false,
    doneAt: null,
    priority: 0,
    type: 'work',
    remindAt: null,
    remindFired: null,
    createdAt: now,
    updatedAt: now,
    order: 0,
    groupId: null,
    carriedFrom: null,
  }

  const push = await req('POST', '/api/sync', { ...empty, tasks: [task] })
  check('推送任务成功', push.status === 200, `HTTP ${push.status}`)
  const got = ((push.json && push.json.tasks) || []).find((t) => t.id === id)
  check('返回结果包含刚推送的任务', !!got, got ? `type=${got.type}` : '未找到')

  const again = await req('POST', '/api/sync', empty)
  check('任务已持久化在电脑端', !!((again.json && again.json.tasks) || []).find((t) => t.id === id))

  const del = await req('POST', '/api/sync', { ...empty, tombstones: { [id]: Date.now() + 2000 } })
  check('墓碑删除会传播', !((del.json && del.json.tasks) || []).find((t) => t.id === id), '删除后不应再出现')

  process.stdout.write(lines.join('\n') + '\n')
  process.stdout.write(failed === 0 ? 'SYNC TEST OK\n' : `SYNC TEST FAILED (${failed})\n`)
  process.exit(failed === 0 ? 0 : 1)
})().catch((e) => {
  process.stdout.write('SYNC TEST CRASH: ' + ((e && e.stack) || e) + '\n')
  process.exit(1)
})
