'use strict'

/**
 * 把 assets/icon.png 包装成 Windows 的 icon.ico。
 * 256×256 的 PNG 压缩条目（Vista+ 标准），单条目即可满足安装包/快捷方式图标。
 */

const fs = require('node:fs')
const path = require('node:path')

const pngPath = path.join(__dirname, '..', 'assets', 'icon.png')
const icoPath = path.join(__dirname, '..', 'assets', 'icon.ico')

const png = fs.readFileSync(pngPath)

// ICONDIR（6 字节）
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0) // 保留
header.writeUInt16LE(1, 2) // 类型：图标
header.writeUInt16LE(1, 4) // 图像数量

// ICONDIRENTRY（16 字节）
const entry = Buffer.alloc(16)
entry[0] = 0 // 宽度 0 = 256
entry[1] = 0 // 高度 0 = 256
entry[2] = 0 // 调色板
entry[3] = 0 // 保留
entry.writeUInt16LE(1, 4) // 色平面
entry.writeUInt16LE(32, 6) // 位深
entry.writeUInt32LE(png.length, 8) // 数据长度
entry.writeUInt32LE(6 + 16, 12) // 数据偏移

fs.writeFileSync(icoPath, Buffer.concat([header, entry, png]))
process.stdout.write(`已生成 ${icoPath}（${6 + 16 + png.length} 字节）\n`)
