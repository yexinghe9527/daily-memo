'use strict'

/**
 * 生成安卓启动器图标，替换 Capacitor 默认图标。
 *  - ic_launcher.png / ic_launcher_round.png：完整图标（圆角方块 + 对勾），各密度
 *  - ic_launcher_foreground.png：自适应图标前景（内容居中缩放，避开圆形遮罩裁切）
 * 用法：node tools/make-android-icons.js
 */

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

/* ---------------- PNG 编码（与 make-icon.js 相同） ---------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
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

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0
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
function coverage(dist, edge) {
  return clamp01(edge - dist + 0.5)
}
function roundRectDistance(x, y, cx, cy, hw, hh, r) {
  const dx = Math.abs(x - cx) - (hw - r)
  const dy = Math.abs(y - cy) - (hh - r)
  const ax = Math.max(dx, 0)
  const ay = Math.max(dy, 0)
  const outside = Math.sqrt(ax * ax + ay * ay)
  const inside = Math.min(Math.max(dx, dy), 0)
  return outside + inside - r
}
function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax
  const vy = by - ay
  const wx = px - ax
  const wy = py - ay
  const len2 = vx * vx + vy * vy
  const t = len2 === 0 ? 0 : clamp01((wx * vx + wy * vy) / len2)
  return Math.hypot(wx - vx * t, wy - vy * t)
}
function mix(a, b, t) {
  return Math.round(a + (b - a) * t)
}

/** 按任意尺寸渲染图标（256 基准按比例缩放） */
function renderIcon(size) {
  const sc = size / 256
  const rgba = Buffer.alloc(size * size * 4)
  const cx = 128 * sc
  const cy = 128 * sc
  const half = 118 * sc
  const radius = 56 * sc
  const bgA = [109, 123, 255]
  const bgB = [150, 84, 255]
  const STROKE = 13 * sc

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const bgDist = roundRectDistance(x + 0.5, y + 0.5, cx, cy, half, half, radius)
      const bgAlpha = coverage(bgDist, 0)
      const t = clamp01((x / size) * 0.45 + (y / size) * 0.55)
      const r = mix(bgA[0], bgB[0], t)
      const g = mix(bgA[1], bgB[1], t)
      const b = mix(bgA[2], bgB[2], t)
      const d1 = segDist(x + 0.5, y + 0.5, 74 * sc, 132 * sc, 112 * sc, 172 * sc)
      const d2 = segDist(x + 0.5, y + 0.5, 112 * sc, 172 * sc, 186 * sc, 92 * sc)
      const checkAlpha = coverage(Math.min(d1, d2), STROKE) * bgAlpha
      const isCheck = checkAlpha > 0
      const cr = mix(r, 255, checkAlpha)
      const cg = mix(g, 255, checkAlpha)
      const cb = mix(b, 255, checkAlpha)
      const shade = clamp01((x / size) * 0.5 + (y / size) * 0.5) * 0.06
      rgba[i] = isCheck ? cr : Math.round(r * (1 - shade))
      rgba[i + 1] = isCheck ? cg : Math.round(g * (1 - shade))
      rgba[i + 2] = isCheck ? cb : Math.round(b * (1 - shade))
      rgba[i + 3] = Math.round(bgAlpha * 255)
    }
  }
  return rgba
}

/** 把图标居中放到更大的透明画布上（自适应前景用） */
function placeOnCanvas(iconSize, canvasSize) {
  const icon = renderIcon(iconSize)
  const out = Buffer.alloc(canvasSize * canvasSize * 4)
  const off = Math.floor((canvasSize - iconSize) / 2)
  for (let y = 0; y < iconSize; y++) {
    icon.copy(out, ((off + y) * canvasSize + off) * 4, y * iconSize * 4, (y + 1) * iconSize * 4)
  }
  return out
}

function main() {
  const resDir = path.join(__dirname, '..', 'mobile', 'android', 'app', 'src', 'main', 'res')
  // 传统图标（完整图标）
  const legacy = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 }
  // 自适应前景画布尺寸
  const adaptive = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 }

  for (const [dpi, size] of Object.entries(legacy)) {
    const dir = path.join(resDir, `mipmap-${dpi}`)
    fs.mkdirSync(dir, { recursive: true })
    const icon = encodePng(size, renderIcon(size))
    fs.writeFileSync(path.join(dir, 'ic_launcher.png'), icon)
    fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), icon)
    process.stdout.write(`legacy ${dpi}: ${size}x${size}\n`)
  }
  for (const [dpi, canvas] of Object.entries(adaptive)) {
    const dir = path.join(resDir, `mipmap-${dpi}`)
    const iconSize = Math.round(canvas * 0.55)
    const fg = encodePng(canvas, placeOnCanvas(iconSize, canvas))
    fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.png'), fg)
    process.stdout.write(`foreground ${dpi}: ${canvas}x${canvas} (icon ${iconSize})\n`)
  }
  // 自适应背景色：深空蓝，与星辰主题呼应
  const bgXml = path.join(resDir, 'values', 'ic_launcher_background.xml')
  const xml = '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#1B2444</color>\n</resources>\n'
  fs.writeFileSync(bgXml, xml)
  process.stdout.write('已更新 ic_launcher_background.xml (#1B2444)\n')
  process.stdout.write('安卓图标生成完成\n')
}

main()
