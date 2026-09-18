'use strict'

/**
 * 生成 README 用的**桌面端**截图（浅色 + 星辰大海）。
 *
 * 做法：直接把真实应用跑起来（require src/main.js），只是把 userData 指向一个
 * 装了虚构数据的一次性目录。所以截出来的是真实界面、真实数据层，
 * 又绝不会读到或覆盖你自己的数据。
 *
 * 演示数据里 syncEnabled / autoCheckUpdate 均为 false —— 不会占 8765 端口，也不联网。
 *
 * 用法：npx electron tools/screenshots-desktop.js
 * 产物：docs/screenshots/desktop-light.png、desktop-galaxy.png
 */

const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const root = path.join(__dirname, '..')
const outDir = path.join(root, 'docs', 'screenshots')
const demoDir = path.join(os.tmpdir(), 'xinghelu-demo')

/* 1) 先用真实数据层生成虚构演示数据（与手机端截图共用同一份 dataset） */
{
  const { Store } = require(path.join(root, 'src', 'store'))
  const { seed } = require('./make-demo-data')
  fs.mkdirSync(demoDir, { recursive: true })
  const file = path.join(demoDir, 'data.json')
  if (fs.existsSync(file)) fs.rmSync(file)
  seed(new Store(file))
}

/* 2) 隔离数据目录必须在 require main.js 之前设置好 */
app.setPath('userData', demoDir)

/* 3) 启动真实应用 */
require(path.join(root, 'src', 'main.js'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, label, timeout = 25000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    // 同步返回值和 Promise 都要能处理
    const v = await Promise.resolve()
      .then(fn)
      .catch(() => null)
    if (v) return v
    await sleep(150)
  }
  throw new Error(`等待超时：${label}`)
}

async function main() {
  await app.whenReady()

  const win = await waitFor(() => BrowserWindow.getAllWindows()[0] || null, '窗口创建')
  win.setContentSize(1280, 860) // 固定尺寸，保证每次截图一致
  win.show()

  const js = (code) => win.webContents.executeJavaScript(code)

  // 等真实渲染完成（任务列表有内容 + 日期标题已填）
  await waitFor(
    () => js(`document.querySelectorAll('.task-item').length > 0 && document.getElementById('dateTitle').textContent !== '—'`),
    '任务列表渲染'
  )

  // 启动 3 秒后会跑一次 tick：未完成顺延 → 出现「顺延自」横幅。
  // 这是最终稳定状态，等它出现再截，画面才完整。
  const carried = await waitFor(() => js(`!document.getElementById('carryBanner').hidden`), '顺延横幅', 12000).catch(
    () => false
  )
  if (!carried) console.warn('提示：没等到顺延横幅，按当前状态继续截图')

  await sleep(500)
  fs.mkdirSync(outDir, { recursive: true })

  // 流星是 7.5s 循环、前 22% 飞完全程的动画，随机时刻截图基本抓不到。
  // 用 Web Animations API 把一颗定格在飞行中段、另两颗停在屏外，
  // 既保证截图里一定有流星，又忠实于真实效果（任意时刻最多一颗在飞）。
  const FREEZE_METEORS = `(() => {
    const FLIGHT_MID = 0.11   // 22% 走完全程，11% 正好在中段
    const HIDDEN = 0.35       // 24% 之后已淡出
    const showIndex = 1
    const stars = [...document.querySelectorAll('.shooting-star')]
    return JSON.stringify(stars.map((el, i) => {
      const anims = el.getAnimations()
      if (!anims.length) return { i, err: 'no-animation' }
      const a = anims[0]
      const t = a.effect.getTiming()
      const duration = Number(t.duration) || 0
      const delay = Number(t.delay) || 0
      a.pause()
      a.currentTime = delay + duration * (i === showIndex ? FLIGHT_MID : HIDDEN)
      const cs = getComputedStyle(el)
      return {
        i,
        delay,
        currentTime: Math.round(a.currentTime),
        opacity: Number(cs.opacity).toFixed(2),
        display: cs.display,
        transform: cs.transform === 'none' ? 'none' : 'set',
      }
    }))
  })()`

  const shots = [
    { file: 'desktop-light.png', theme: 'light' },
    { file: 'desktop-galaxy.png', theme: 'galaxy', meteors: true },
  ]

  for (const shot of shots) {
    // 走设置里那个真实的下拉框，和用户手改主题是同一条代码路径；
    // 不用点 #themeBtn 是因为它会弹 toast，会糊在截图上。
    const applied = await js(`(() => {
      const sel = document.getElementById('setTheme')
      if (!sel) return 'no-setTheme'
      sel.value = ${JSON.stringify(shot.theme)}
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      return 'ok'
    })()`)
    if (applied !== 'ok') throw new Error(`切换主题失败：${applied}`)

    await sleep(1400) // 等重绘

    if (shot.meteors) {
      const report = JSON.parse(await js(FREEZE_METEORS))
      const visible = report.filter((m) => m.opacity && Number(m.opacity) > 0.5)
      console.log(`  流星定格：${JSON.stringify(report)}`)
      if (visible.length !== 1) throw new Error(`流星定格异常：应有 1 颗可见，实际 ${visible.length} 颗`)
      await sleep(300)
    }

    const actual = await js(`document.documentElement.dataset.theme`)
    const image = await win.webContents.capturePage()
    const png = image.toPNG()
    fs.writeFileSync(path.join(outDir, shot.file), png)

    const size = image.getSize()
    const ok = actual === shot.theme
    console.log(
      `${ok ? '✓' : '✗'} ${shot.file}  ${size.width}x${size.height}  ${(png.length / 1024).toFixed(0)} KB  theme=${actual}（期望 ${shot.theme}）`
    )
    if (!ok) throw new Error(`主题没生效：期望 ${shot.theme}，实际 ${actual}`)
  }

  await sleep(200)
  app.exit(0)
}

main().catch((err) => {
  console.error('截图失败：', (err && err.stack) || err)
  app.exit(1)
})
