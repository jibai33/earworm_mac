# 闻曲 Earworm · macOS 桌面版

> 听曲知雅意 —— 国风沉浸式音乐播放器，原生 macOS 外壳 + 内嵌本地音源服务。

本仓库是 Web 版 [earworm](https://github.com/jibai33/earworm) 的 **macOS 桌面版**，骨架参考
[Mineradio](https://github.com/jibai33/Mineradio-paused)（Electron 桌面播放器），把「浏览器里开一个网页」升级为真正的 Mac 应用：菜单栏常驻、全局媒体键、迷你播放器、系统「正在播放」。

![闻曲 macOS 主界面](docs/screenshot-home.jpg)

![迷你播放器](docs/screenshot-mini.png)

---

## 与 Web 版的区别

| | Web 版 | macOS 桌面版（本仓库） |
|---|---|---|
| 运行形态 | `node server.js` + 浏览器 | 双击 App，服务进程内嵌，不占端口、不弹浏览器 |
| 播放控制 | 页面内 | 菜单栏 / Dock / 全局媒体键 / 迷你播放器 |
| 汽水扫码登录 | 依赖本机 Chrome + CDP 模拟 | 直接用 Electron `BrowserWindow` 跑官方 SDK，不再需要装 Chrome |
| 凭据 / 听感画像 | 写在工程目录 | 写入 `~/Library/Application Support/闻曲/data`，App 包只读、签名不被破坏 |
| Service Worker | 离线缓存 | 桌面版自动禁用（随 App 更新，避免旧缓存） |
| 窗口 | 浏览器标签 | 原生标题栏（红绿灯内嵌）、全屏、记忆窗口位置、关闭后留在菜单栏 |

前端（`app/web`）与音源服务（`app/server.js`、`app/modules`）与 Web 版同源，
桌面版只新增 `electron/` 一层，不改动任何播放器业务逻辑。

---

## 功能

- **四平台音源**：网易云 / QQ 音乐 / 汽水音乐 / 小宇宙，统一检索与播放（`/api/unified/*`）
- **登录**：网易云扫码、汽水抖音扫码、QQ 三通道扫码（手机 QQ / 微信 / QQ 音乐 App）、小宇宙短信
- **国风视觉**：墨染开机动画、封面取色墨晕舞台、分层入场动效、黑胶旋转
- **听感画像**：收听 50% / 搜索 30% / 浏览 20% 加权推荐，支持同步码跨端共用（Web / macOS / iOS）
- **macOS 原生**：
  - 菜单栏图标 + 右键菜单（当前曲目 / 播放暂停 / 上下曲 / 迷你播放器）
  - Dock 菜单、系统媒体键（⏯ ⏭ ⏮）、控制中心「正在播放」
  - **迷你播放器**：520×132 悬浮小窗，可置顶、可拖动进度、双击回主窗
  - 关闭窗口不退出（`Cmd+Q` 才退出），单实例运行

---

## 开发

```bash
npm install
npm start          # 启动桌面版
npm run dev        # 启动并打开开发者工具
npm run server     # 只跑本地音源服务（浏览器访问 http://localhost:3210/app/）
```

环境：macOS 11+、Node 22+。

### 调试

```bash
EARWORM_DEV=1 npx electron .            # 打开 DevTools
EARWORM_REMOTE_DEBUG=9222 npx electron . # 暴露 DevTools 协议端口（可接 puppeteer）
```

### 与 Web 版的关系

**两端完全独立。** 本仓库自带完整的服务端与前端（`app/server.js`、`app/modules`、`app/web`），
不依赖也不引用 `earworm` 仓库的任何文件，两边各自演进、互不覆盖：

- 桌面端为了写数据到 `~/Library/Application Support/闻曲`、绕过只读 App 包等原因，对路径做了本仓库内的改造；
- 因此**不要**用 `rsync` / 复制的方式从 Web 仓库覆盖 `app/`，那会把桌面端的改动冲掉；
- 需要借鉴 Web 端的某个具体实现时，手动挑那一段改过来即可，不做整体同步。

### 目录结构

```
electron/             # macOS 外壳（新增）
  main.js             #   主进程：内嵌服务、窗口、托盘、媒体键、IPC
  menu.js             #   系统菜单栏
  preload.js          #   注入桌面版外观 / 采集播放状态 / 系统「正在播放」
  mini.html           #   迷你播放器（独立无边框窗口）
  mini-preload.js
  mac-chrome.css      #   红绿灯让位与拖拽区（仅桌面版注入）
app/                  # 与 Web 版同源
  server.js           #   本地音源服务（HTTP，仅监听 127.0.0.1）
  modules/            #   网易云 / QQ / 汽水 / 小宇宙 / 画像 / 推荐
  web/                #   原生 HTML/CSS/JS 前端
  user-paths.js       #   可写目录解析（桌面版指向 Application Support）
scripts/make-icons.js # 生成 icon.icns 与菜单栏模板图标
build/                # 图标、entitlements
```

### 打包

```bash
npm run icons      # 重新生成图标（需要本机 Chrome）
npm run build:mac  # 产出 dist/*.dmg 与 *.zip（arm64 + x64）
npm run build:dir  # 只产出 dist/mac*/闻曲.app，便于本地验证
```

未配置签名证书时，首次打开需右键 →「打开」，或执行：

```bash
xattr -dr com.apple.quarantine /Applications/闻曲.app
```

---

## 快捷键

| 操作 | 快捷键 |
|---|---|
| 播放 / 暂停 | 菜单栏「播放」，或系统媒体键 |
| 上一首 / 下一首 | `Cmd+←` / `Cmd+→`，或媒体键 |
| 喜欢当前曲目 | `Cmd+L` |
| 音量 ± | `Cmd+↑` / `Cmd+↓` |
| 静音 | `Cmd+Alt+M` |
| 搜索 | `Cmd+F` |
| 首页 / 曲库 | `Cmd+1` / `Cmd+2` |
| 迷你播放器 | `Cmd+Shift+M` |
| 偏好设置 | `Cmd+,` |

---

## 数据与隐私

| 内容 | 位置 |
|---|---|
| 登录凭据（网易云 / QQ / 汽水 / 小宇宙） | `~/Library/Application Support/闻曲/data/` |
| 听感画像 `taste-profiles.json` | 同上 |
| 窗口位置 | `~/Library/Application Support/闻曲/window-state.json` |
| 迷你播放器位置 | `~/Library/Application Support/闻曲/mini-state.json` |

所有凭据仅保存在本机，不上传任何服务器。听感画像只在你自己填了同一个同步码的设备之间共享。

---

## 许可

GPL-3.0-only。播放器骨架与部分登录实现衍生自 [Mineradio](https://github.com/jibai33/Mineradio-paused)，
音源接口来自 `NeteaseCloudMusicApi` 与各平台公开 Web API。仅供个人学习与自用。
