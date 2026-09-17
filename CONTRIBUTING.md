# 贡献指南

感谢愿意帮忙！这个项目很小，流程也很轻。

## 环境要求

| | |
| --- | --- |
| Node.js | 20 或更高 |
| JDK | **21**（Capacitor 8 要求；只用桌面端的话不需要） |
| Android SDK | platform 36 / build-tools 36（只构建安卓时需要） |

## 本地跑起来

```bash
git clone <your-fork>
cd daily-memo
npm install
npm start
```

## 提交前请跑测试

```bash
npm run selftest                    # 数据层 34 项断言（纯 Node，最快）
node mobile/test/store.test.js      # 安卓数据层 11 项断言
npm run smoke                       # 桌面端到端（真启动 Electron）
npx electron mobile/test/smoke.js   # 安卓端到端
```

CI 会在 PR 上跑这些。**改了数据层逻辑请顺手补断言**——
`src/selftest.js` 和 `mobile/test/store.test.js` 是这套代码的安全网。

## 代码约定

- **界面零框架**：不引入 React/Vue，不引入打包器。用 `createElement` + `textContent` 建 DOM
- **不要拼 `innerHTML`**：所有用户内容一律走 `textContent`，这是 XSS 防线
- **设置项要过白名单**：`saveSettings` 是按字段白名单存的，加新设置项**必须同时在白名单里加**，
  否则会出现"界面填了但存不下来"的静默 bug（历史上真踩过两次）
- **两端逻辑要对齐**：`src/store.js`（桌面）和 `mobile/www/store.js`（安卓）是同一套业务逻辑的两份实现，
  改一边记得改另一边。`src/renderer/app.js` 与 `mobile/www/app.js` 同理
- **新增主进程能力**：走 `preload.js` 白名单暴露，不要在渲染进程直接碰 Node

## 数据库改动

`store.js` 的 `_migrate` 负责向前兼容。**加字段必须写迁移**，老用户的数据不能丢，
参考 `remindAt` 从 `HH:mm` 迁到完整日期时间的写法。

## 关于国内网络

仓库里默认配了国内镜像（Gradle 走腾讯、Maven 走阿里云），是给中文 Windows 环境用的。
如果你在海外，可以把 `mobile/android/gradle/wrapper/gradle-wrapper.properties` 的
`distributionUrl` 换回官方地址，速度更快。

## 中文 Windows 特有的坑

构建安卓时**必须**设 `-Dfile.encoding=UTF-8`，否则 `core-for-system-modules` 转换会报
「编码 GBK 的不可映射字符」。详见 [`mobile/README.md`](mobile/README.md)。

## 提交 PR

1. Fork → 建分支（`fix/xxx` 或 `feat/xxx`）
2. 改完跑一遍上面的测试
3. PR 里说清楚：**改了什么、为什么、怎么验证的**

界面改动最好附一张截图。
