'use strict'

/**
 * 下载源探针：用 Node 自己的 HTTPS 栈（和 Electron 安装脚本同一套）测试
 * 各个镜像是否真的可下载，避免装依赖时盲等。
 *
 * 用法：node tools/net-probe.js <url> [url...]
 */

const https = require('node:https')

const TIMEOUT_MS = 20000

function head(url) {
  return new Promise((resolve) => {
    let settled = false
    const done = (r) => {
      if (settled) return
      settled = true
      resolve(r)
    }
    let req
    try {
      req = https.request(url, { method: 'HEAD', timeout: TIMEOUT_MS }, (res) => {
        const len = res.headers['content-length']
        done({ url, status: res.statusCode, len: len == null ? '-' : len, loc: res.headers.location })
        res.resume()
      })
    } catch (err) {
      return done({ url, error: err.message })
    }
    req.on('timeout', () => {
      req.destroy()
      done({ url, error: `超时（${TIMEOUT_MS}ms 内无响应）` })
    })
    req.on('error', (err) => done({ url, error: err.message }))
    req.end()
  })
}

async function main() {
  const urls = process.argv.slice(2)
  if (!urls.length) {
    process.stdout.write('用法：node tools/net-probe.js <url> [url...]\n')
    process.exit(2)
  }
  let bad = 0
  for (const u of urls) {
    const r = await head(u)
    if (r.error) {
      bad++
      process.stdout.write(`FAIL  ${r.error}\n      ${r.url}\n`)
    } else {
      const mb = r.len === '-' ? '' : ` (${(Number(r.len) / 1048576).toFixed(1)} MB)`
      process.stdout.write(`OK    HTTP ${r.status}  len=${r.len}${mb}${r.loc ? '  → ' + r.loc : ''}\n      ${r.url}\n`)
    }
  }
  process.exit(bad === urls.length ? 1 : 0)
}

main()
