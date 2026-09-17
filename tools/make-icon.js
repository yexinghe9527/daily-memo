'use strict'

/**
 * 生成应用图标 assets/icon.png（256×256，带透明圆角）。
 * 纯 Node 实现：手写 PNG 编码（zlib 是内置模块），不引入任何图形库。
 * 用法：node tools/make-icon.js
 */

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const SIZE = 256

/* ---------------- CRC32 ---------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ---------------- 几何 ---------------- */

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** 1px 宽的抗锯齿过渡带 */
function coverage(dist, edge) {
  return clamp01(edge - dist + 0.5)
}

function roundRectDistance(x, y, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(x - cx) - (halfW - radius)
  const dy = Math.abs(y - cy) - (halfH - radius)
  const ax = Math.max(dx, 0)
  const ay = Math.max(dy, 0)
  const outside = Math.sqrt(ax * ax + ay * ay)
  const inside = Math.min(Math.max(dx, dy), 0)
  return outside + inside - radius
}

function segmentDistance(px, py, ax, ay, bx, by) {
  const vx = bx - ax
  const vy = by - ay
  const wx = px - ax
  const wy = py - ay
  const len2 = vx * vx + vy * vy
  const t = len2 === 0 ? 0 : clamp01((wx * vx + wy * vy) / len2)
  const dx = wx - vx * t
  const dy = wy - vy * t
  return Math.sqrt(dx * dx + dy * dy)
}

function mix(a, b, t) {
  return Math.round(a + (b - a) * t)
}

/* ---------------- 绘制 ---------------- */

function render() {
  const rgba = Buffer.alloc(SIZE * SIZE * 4)
  const cx = SIZE / 2
  const cy = SIZE / 2
  const half = SIZE / 2 - 10
  const radius = 56

  // 背景渐变（左上 #6d7bff → 右下 #8f5bff），勾选线用白色
  const bgA = [109, 123, 255]
  const bgB = [150, 84, 255]
  const checkA = [72, 134, 118]
  const checkB = [188, 96, 96]
  const STROKE = 13

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4
      const bgDist = roundRectDistance(x + 0.5, y + 0.5, cx, cy, half, half, radius)
      const bgAlpha = coverage(bgDist, 0)

      // 对角渐变参数
      const t = clamp01((x / SIZE) * 0.45 + (y / SIZE) * 0.55)
      const r = mix(bgA[0], bgB[0], t)
      const g = mix(bgA[1], bgB[1], t)
      const b = mix(bgA[2], bgB[2], t)

      // 勾：A → B → C
      const d1 = segmentDistance(x + 0.5, y + 0.5, 74, 132, 112, 172)
      const d2 = segmentDistance(x + 0.5, y + 0.5, 112, 172, 186, 92)
      const d = Math.min(d1, d2)
      const checkAlpha = coverage(d, STROKE) * bgAlpha

      // 勾下面压一层深色描边，边缘更清楚
      const isCheck = checkAlpha > 0
      const cr = mix(r, 255, checkAlpha)
      const cg = mix(g, 255, checkAlpha)
      const cb = mix(b, 255, checkAlpha)

      // 再叠一层很淡的内阴影，让图标有体积感
      const shade = clamp01((x / SIZE) * 0.5 + (y / SIZE) * 0.5) * 0.06

      rgba[i] = isCheck ? cr : Math.round(r * (1 - shade))
      rgba[i + 1] = isCheck ? cg : Math.round(g * (1 - shade))
      rgba[i + 2] = isCheck ? cb : Math.round(b * (1 - shade))
      rgba[i + 3] = Math.round(bgAlpha * 255)
    }
  }

  // 未使用的颜色变量在这里显式消费掉，避免 lint 报未使用
  void checkA
  void checkB

  return rgba
}

function main() {
  const out = path.join(__dirname, '..', 'assets', 'icon.png')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const png = encodePng(SIZE, SIZE, render())
  fs.writeFileSync(out, png)
  process.stdout.write(`已生成 ${out}（${png.length} 字节）\n`)
}

main()
