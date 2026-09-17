# 星河录 · Xinghelu

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Android-lightgrey.svg)](https://github.com/yexinghe9527/daily-memo/releases)
[![Latest release](https://img.shields.io/github/v/release/yexinghe9527/daily-memo?color=blue)](https://github.com/yexinghe9527/daily-memo/releases/latest)

**不联网、不要账号、数据只在你自己的设备上。**

一个本地优先（local-first）的每日任务与备忘应用：**Windows 桌面 + 安卓**双端，
两台设备之间**通过局域网直连同步**——不需要云服务器，不需要注册，数据不出你的内网。

> A local-first daily task & memo app for Windows and Android.
> **Syncs directly over your LAN — no cloud, no account, your data never leaves your network.**

---

## 为什么做这个

市面上的待办应用几乎都要求你注册账号、把数据传到它们服务器上。但在很多地方这是行不通的：
设计院、制造业车间、实验室、医院内网、涉密单位——**电脑根本连不上外网**，云工具进不去。

星河录的做法是把同步放回局域网：

- 📴 **完全离线可用**：断网照样能记、能改、能提醒
- 🔒 **没有服务器**：不存在"厂商倒闭数据就没了"
- 👤 **不要账号**：打开就能用
- 🔄 **局域网直连同步**：手机连同一个 Wi-Fi，点一下就和电脑对齐
- 🪶 **轻**：安卓包只有 3MB，桌面端零运行时依赖

## 功能

| | |
| --- | --- |
| 任务管理 | 增删改查、勾选、双击改标题、拖拽排序 |
| 分类 | **类型（工作 / 私人 / 未分类）**、优先级（普通 / 重要 / 紧急）、按类型筛选 |
| 到点提醒 | 精确到「年月日时分」；桌面弹系统通知，安卓走系统级本地通知（**关掉应用也会响**） |
| 重复任务 | 每天 / 工作日 / 每周 / 每月，按天懒生成；改一次可同步到未来所有实例 |
| 未完成顺延 | 打开应用时把过去没做完的搬到今天，并标注「顺延自 x/x」 |
| 每日备忘 | 每天一块随手记，停手自动保存 |
| 日历与统计 | 月历总览、今日完成率、连续达成天数、最近 7 天 |
| 搜索 | 任务标题、备注、备忘全文搜索 |
| 主题 | 跟随系统 / 浅色 / 深色 / **星辰大海**（星空 + 流星） |
| 数据自主 | 一键导出/导入 JSON，数据就是一个普通文件 |

## 界面

*（建议放 4 张截图：桌面浅色、桌面星辰大海、手机任务列表、手机同步设置）*

## 下载

从 [**Releases**](https://github.com/yexinghe9527/daily-memo/releases/latest) 下载最新版本：

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| Windows | `Xinghelu-Setup-x.y.z.exe` | 免管理员权限安装，自动建快捷方式；未签名，首次运行需点「更多信息 → 仍要运行」 |
| Android | 仓库 Release 里的 `.apk` | 首次安装需允许「未知来源」 |

> 也可以从源码自行构建，见下文。

安装后**会自动检查更新**（可在设置里关掉），新版发布会提示你重启生效。

## 关于联网（重要）

星河录的卖点是「不联网」，所以这里把联网的地方**如实列全**，两处都能关：

| 用途 | 何时联网 | 发什么 | 怎么关 |
| --- | --- | --- | --- |
| **手机同步** | 你点同步，或手机打开/切回应用时 | 把你的完整任务数据发给**你自己填的电脑地址**（局域网内） | 不填地址就完全不联网 |
| **自动检查更新** | 打包版启动后 12 秒，之后每 6 小时 | 向 GitHub Releases 发一次 GET 查版本号 | 设置 → 关闭「自动检查更新」 |

除此之外**没有任何遥测、统计、崩溃上报**。
自动更新的实现里也不含任何用户标识——它只是下载 `latest.yml` 比一下版本号。

## 同步是怎么工作的

**电脑是服务端，手机是客户端**，通过局域网 HTTP 直连：

```
手机 (Capacitor WebView)                电脑 (Electron 主进程)
        │                                        │
        │  POST /api/sync  { 本地全量快照 }       │
        ├───────────────────────────────────────►│
        │                                        │  合并（后写入者胜出 + 删除墓碑）
        │  ◄──────────  合并后的全量快照  ────────┤
        │                                        │
     合并（同一套算法）→ 两端收敛一致
```

- **合并算法**：记录级「后写入者胜出」（比较每条记录的 `updatedAt`），
  删除用**墓碑**（tombstone）表达——所以删掉的任务不会被另一端又合并回来
- **开箱即用**：手机打开应用 / 切回前台会**自动同步**，也可以点顶栏的 ⟳ 手动同步
- **限制**：手机与电脑必须在**同一个 Wi-Fi**。想在 4G/5G 下也同步，
  给两台设备都装 [Tailscale](https://tailscale.com/)，把手机里的地址填成电脑的 Tailscale IP（`100.x.x.x:8765`）即可，无需改路由器

## 快速开始

1. **电脑**：打开星河录 → ⚙ 设置 → 勾选「开启手机同步服务」→ 记下显示的地址（形如 `http://192.168.1.5:8765`）
2. **手机**：连到同一个 Wi-Fi → ⚙ 设置 → 「电脑地址」填上那个地址 → 点「立即与电脑同步」

> 电脑端点 ✕ 会**最小化到系统托盘**继续后台运行，提醒不会因为关窗口而失效；
> 托盘右键菜单里有「退出星河录」。

## 从源码构建

### 桌面端（Windows）

```bash
npm install
npm start          # 开发运行
npm run selftest   # 数据层自检（34 项，纯 Node）
npm run smoke      # 端到端冒烟（真启动 Electron 自检，退出码即结果）
npm run dist       # 打 NSIS 安装包到 dist/
```

### 安卓端

需要 **JDK 21** + **Android SDK 36**（Capacitor 8 要求 JDK 21）。

```bash
cd mobile
npm install
npx cap sync android
cd android
./gradlew assembleRelease
# 产物：app/build/outputs/apk/release/app-release.apk
```

签名：复制 `mobile/android/keystore.properties.example` 为 `keystore.properties` 填自己的密钥
（该文件已 gitignore，**不要提交**）。不配也能构建，只是产出未签名包。

详见 [`mobile/README.md`](mobile/README.md)，里面有中文 Windows 特有的坑（GBK 编码、国内镜像等）。

## 发布与自动更新

1. 改 `package.json` 里的 `version`
2. 打 tag 并推送：`git tag v1.0.1 && git push origin v1.0.1`
3. CI 自动构建 Windows 安装包 + 安卓 APK，创建 GitHub Release
   （会带上 `latest.yml` 和 `.blockmap`，客户端靠它们发现新版并做增量下载）

客户端启动 12 秒后检查一次更新，发现新版就后台下载，完成后通知你重启生效；
托盘右键菜单和设置里都能手动检查。

> ⚠️ 上线前必改两处，否则更新会 404：
> - `electron-builder.yml` 里 `publish.owner` / `publish.repo` 换成你自己的账号和仓库
> - **`artifactName` 必须保持 ASCII**。electron-builder 会对非 ASCII 产物名做「安全化」，
>   使得 `latest.yml` 里写的文件名和实际文件对不上（这个坑踩过，改成中文名就会坏）

## 架构

```
src/                       桌面端（Electron）
├─ main.js                 主进程：窗口、IPC、托盘、同步服务、跨天检测、提醒轮询
├─ preload.js              contextBridge 白名单（contextIsolation + sandbox 全开）
├─ store.js                数据层：本地 JSON 原子写入 + 全部业务逻辑 + 同步合并
├─ selftest.js             数据层断言
└─ renderer/               界面（原生 HTML/CSS/JS，无打包器）

mobile/                    安卓端（Capacitor）
├─ www/
│  ├─ store.js             同一套数据层逻辑，持久化换成 localStorage
│  ├─ bridge.js            复刻桌面 preload 的 window.memoApi（含本地通知排程）
│  ├─ app.js               与桌面版**完全同一份**界面逻辑
│  ├─ mobile.css           手机布局覆盖（仅 body.mobile 下生效）
│  └─ mobile-ui.js         抽屉 / 搜索栏 / 状态栏配色
└─ android/                原生工程

tools/
├─ make-icon.js            手写 PNG 编码生成图标（零图形依赖）
├─ make-android-icons.js   生成各密度启动器图标 + 自适应前景
├─ net-probe.js            下载源连通性探针
└─ test-sync.js            同步服务端到端测试
```

几个实现上的取舍：

- **界面零框架**：没有 React/Vue，没有打包器。用 `createElement` + `textContent` 构建 DOM，
  天然免疫 XSS。桌面和安卓共用同一份 `app.js`
- **数据层一分为二、逻辑对齐**：桌面用 `fs`（写临时文件后原子重命名），安卓用 `localStorage`；
  业务逻辑逐行对齐，两端各有独立自测
- **同步无中间件**：不引入数据库、不引入消息队列，就是「交换全量快照 + 合并」
- **安全默认值**：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`、CSP 全开

## 测试

```bash
npm run selftest                    # 桌面数据层断言
node mobile/test/store.test.js      # 安卓数据层断言
npm run smoke                       # 桌面端到端（含界面回归断言）
npx electron mobile/test/smoke.js   # 安卓端到端（手机尺寸视口）
node tools/test-sync.js             # 同步服务端到端（真发 HTTP）
```

冒烟测试里有不少**量化的界面断言**——比如「日期文字不许被截断」
（比较 `scrollWidth > clientWidth`）、「按钮不许被压成竖排」（比较宽高比）。
这类"看着没坏但其实坏了"的问题，靠断言比靠肉眼可靠。

## 路线图

- [ ] 英文界面（i18n）与英文文档
- [ ] 自动更新（electron-builder publish）
- [ ] 首次使用引导与示例数据
- [ ] 同步认证（目前局域网同步无密码，仅适合可信网络）
- [ ] 跨网络同步开箱可用（内嵌 Tailscale 指引 / 自建服务）
- [ ] 团队 / 多用户版本（内网共享看板）

## 贡献

欢迎 issue 和 PR，详见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。提交前请跑一遍上面的测试。

## 赞助

如果这个项目对你有用，欢迎请作者喝杯咖啡。

> 赞助渠道还没配好：把 `.github/FUNDING.yml` 里的注释取消并填上你的爱发电 / Ko-fi 主页即可。
> 注：GitHub Sponsors 目前**不支持中国大陆收款**，所以主力放在国内可用的渠道。

## 许可

[MIT](LICENSE) —— 随便用、随便改、随便商用，保留版权声明即可。

---

## English

**Xinghelu** is a local-first daily task & memo app for **Windows and Android**.

**The point:** most todo apps want an account and your data on their servers.
That doesn't work in factories, design institutes, labs, or any environment where the
machines have no internet access. Xinghelu keeps everything on your own devices and
syncs **directly over your LAN** — no cloud, no account, no telemetry.

- Offline-first: works with no network at all
- LAN sync: phone and PC on the same Wi-Fi converge with one tap
- Background reminders on Android via system local notifications
- Task types (work / personal), priorities, recurring tasks, carry-over, daily memo,
  calendar, stats, full-text search, JSON export

Build: Electron (desktop) + Capacitor (Android), sharing the same renderer code.
License: MIT.
