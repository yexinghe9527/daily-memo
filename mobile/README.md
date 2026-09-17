# 星河录 · 移动端（安卓）

桌面版的安卓移植：**界面、功能、主题完全一致**（含浅色/深色/星辰大海三种主题），
数据存手机本地 `localStorage`，不联网、不上云。

## 成品

- **正式版 APK**：`星河录-安卓-1.0.0.apk`（项目根目录，约 3MB，已签名）
- 直接把 apk 传到手机安装即可；手机需允许「安装未知来源应用」

> 与桌面版的差异（平台适配）：
> - **界面按手机重排**：单栏纵向布局，顶栏放日期与操作，底部固定「＋ 添加任务」按钮，
>   日历/统计、每日备忘、添加表单分别收进**底部抽屉**；触屏目标加大，输入框全宽 16px 字号
> - **提醒**：可设完整到「年月日时分」（安卓调系统日期时间选择器）。已接入 `@capacitor/local-notifications`，
>   未来提醒会交给系统排程，**关掉应用也能弹通知**，点通知回到对应日期。重复任务的提醒只沿用时间部分，逐天套用。
> - 导出备份走系统分享/下载，导入走文件选择器
> - 「开机自启 / 数据目录」两个桌面专属项在移动端自动隐藏
> - 安卓返回键会**先关抽屉**再退出应用

## 目录结构

```
mobile/
├─ capacitor.config.json        # appId com.xinghelu.app、应用名 星河录
├─ package.json                 # @capacitor/core|cli|android@8
├─ xinghelu-release.keystore    # 签名密钥（别删，以后更新要用同一把）
├─ www/                         # 网页源码（webDir）
│  ├─ index.html                # 手机版结构：顶栏 + 概览 + 任务列表 + 底部操作栏 + 三个抽屉
│  ├─ styles.css                # 复用桌面版样式（主题、卡片、徽标、星辰大海）
│  ├─ mobile.css                # 手机版布局覆盖（只在 body.mobile 下生效）
│  ├─ app.js                    # 复用桌面版交互，零改动
│  ├─ store.js                  # 数据层浏览器版（localStorage）
│  ├─ bridge.js                 # window.memoApi 实现（对应桌面 preload）
│  └─ mobile-ui.js              # 抽屉开合 / 搜索栏 / 状态栏配色 / 关闭触屏拖拽
├─ test/
│  ├─ store.test.js             # 数据层移植自测（node 直接跑）
│  └─ smoke.js                  # 端到端冒烟（electron 加载 www）
└─ android/                     # cap add android 生成的原生工程（已配好镜像/签名）
```

## 重新构建 APK

```powershell
cd mobile
npm install
npm run sync                      # 把 www/ 复制进 android 工程（改了网页源码后必跑）
cd android
$env:JAVA_HOME='<你的 JDK 21 路径>'                    # Capacitor 8 要求 JDK 21
$env:JAVA_TOOL_OPTIONS='-Dfile.encoding=UTF-8'        # 中文 Windows 必加，否则 GBK 报错
.\gradlew.bat assembleRelease
# 产物在 app\build\outputs\apk\release\app-release.apk
```

> 如果所在环境不允许执行 `.bat`（某些受限沙箱会拦），可以绕过：
> ```powershell
> java -classpath gradle\wrapper\gradle-wrapper.jar org.gradle.wrapper.GradleWrapperMain assembleRelease --no-daemon
> ```

### 环境要点

| 项 | 说明 |
| --- | --- |
| JDK | **21**（Capacitor 8 的硬要求，17 会报「无效的源发行版：21」） |
| Android SDK | platform 36 + build-tools 36；在 `android/local.properties` 里用 `sdk.dir=...` 指向它 |
| Gradle 源 | 默认走腾讯镜像（见 `gradle-wrapper.properties`），海外可换回官方地址 |
| Maven 依赖源 | 默认走阿里云镜像（见 `android/build.gradle`），官方源作为兜底 |
| 编码 | **必须** `-Dfile.encoding=UTF-8`。中文 Windows 默认 GBK，会导致 `core-for-system-modules` 转换报「编码 GBK 的不可映射字符」 |
| 签名 | 复制 `android/keystore.properties.example` 为 `keystore.properties` 填自己的密钥（已 gitignore，**不要提交**）。不配也能构建，只是产出未签名包 |

签名信息也可以用环境变量给（CI 走这条）：`XINGHELU_STORE_FILE` / `XINGHELU_STORE_PASSWORD` / `XINGHELU_KEY_ALIAS` / `XINGHELU_KEY_PASSWORD`。

## 自测

```powershell
node mobile/test/store.test.js          # 数据层 9 项断言
# 端到端（需要桌面项目里的 electron）：
E:\codex\dsh\daily-memo\node_modules\electron\dist\electron.exe mobile\test\smoke.js
```

## 还没做

- **桌面/手机数据互通**：目前两端各自本地存储。要做同步，思路是给 `store.js` 加一层同步后端（WebDAV/自建服务），两端都只改「读全量/写全量」这一层即可

## 系统通知说明

提醒由 `@capacitor/local-notifications` 交给 Android 排程，所以**应用被杀掉也会按时弹出**：

- 首次进入应用会请求通知权限（Android 13+ 需要「允许通知」）
- 每次增删改任务、开关提醒、回到前台时，都会**重排一次**未来提醒（最多 50 条）
- 用到的权限：`POST_NOTIFICATIONS`、`SCHEDULE_EXACT_ALARM`（准点）、`RECEIVE_BOOT_COMPLETED`（重启后恢复排程）
- 点通知会打开应用并跳到该任务所属日期
- 原生环境下不再弹应用内提示，避免和系统通知重复；在浏览器里预览时仍走应用内提示
