'use strict';

// ====================================================================
//  闻曲 Earworm · macOS 主进程
//  - 把 app/server.js 作为本地音源服务内嵌进主进程（127.0.0.1 随机端口）
//  - 原生窗口 / 菜单栏 / Dock 菜单 / 全局媒体键 / 迷你播放器
//  - 关闭窗口不退出，Cmd+Q 才退出（macOS 习惯）
// ====================================================================

const {
  app, BrowserWindow, ipcMain, shell, screen, globalShortcut,
  Menu, Tray, nativeImage, dialog, session, nativeTheme,
} = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');

const APP_DIR = path.join(__dirname, '..', 'app');
const IS_DEV = !!process.env.EARWORM_DEV;
const APP_NAME = '闻曲';

// 开发调试：EARWORM_REMOTE_DEBUG=9222 npx electron . 即可用 DevTools 协议连入
if (process.env.EARWORM_REMOTE_DEBUG) {
  app.commandLine.appendSwitch('remote-debugging-port', String(process.env.EARWORM_REMOTE_DEBUG));
}

// 先把应用名定下来，再取 userData：否则目录会落成 earworm-mac
app.setName(APP_NAME);

// ---------- 数据目录（凭据 / 画像 / 窗口状态）----------
const DATA_DIR = path.join(app.getPath('userData'), 'data');
process.env.EARWORM_DATA_DIR = DATA_DIR;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignore */ }

const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');

let mainWindow = null;
let miniWindow = null;
let tray = null;
let serverPort = 0;
let quitting = false;
let miniAlwaysOnTop = true;
let miniBoundsTimer = null;

const playState = {
  playing: false,
  name: '',
  artist: '',
  cover: '',
  position: 0,
  duration: 0,
  liked: false,
  mode: '',
};

/* ==================================================================
   工具
   ================================================================== */

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJSON(file, value) {
  try { fs.writeFileSync(file, JSON.stringify(value, null, 2)); } catch { /* ignore */ }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function waitForServer(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1500 }, (res) => {
        res.resume();
        // 404 也说明 HTTP 服务已经起来了
        resolve();
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('本地音源服务启动超时'));
        else setTimeout(tick, 220);
      });
    };
    tick();
  });
}

/* ==================================================================
   本地音源服务
   ================================================================== */

async function startServer() {
  serverPort = await findFreePort();
  process.env.PORT = String(serverPort);
  process.env.HOST = '127.0.0.1';
  // eslint-disable-next-line global-require
  require(path.join(APP_DIR, 'server.js'));
  await waitForServer(serverPort);
  console.log('[main] 音源服务已就绪 http://127.0.0.1:' + serverPort);
}

/* ==================================================================
   主窗口
   ================================================================== */

function restoreBounds() {
  const saved = readJSON(STATE_FILE, null);
  const area = screen.getPrimaryDisplay().workAreaSize;
  if (!saved || !saved.width) {
    return {
      width: Math.min(1320, Math.round(area.width * 0.82)),
      height: Math.min(860, Math.round(area.height * 0.86)),
    };
  }
  const bounds = { width: saved.width, height: saved.height };
  if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    // 外接屏拔掉后不要把窗口丢到屏幕外
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return saved.x < a.x + a.width - 80 && saved.x + saved.width > a.x + 80
        && saved.y < a.y + a.height - 80 && saved.y + saved.height > a.y + 40;
    });
    if (visible) { bounds.x = saved.x; bounds.y = saved.y; }
  }
  if (saved.maximized) bounds.maximized = true;
  return bounds;
}

function saveBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const b = mainWindow.getNormalBounds();
  writeJSON(STATE_FILE, { ...b, maximized: mainWindow.isMaximized() });
}

function createMainWindow() {
  const bounds = restoreBounds();

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#0b0d10',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 24 },
    fullscreenable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.setTitle(APP_NAME);
  if (bounds.maximized) mainWindow.maximize();

  mainWindow.loadURL(`http://127.0.0.1:${serverPort}/app/`);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  // 站内链接留在窗口，站外链接交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(`http://127.0.0.1:${serverPort}`)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  // 关闭 = 收进菜单栏，而不是退出（macOS 音乐播放器习惯）
  mainWindow.on('close', (event) => {
    saveBounds();
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('resize', debounce(saveBounds, 400));
  mainWindow.on('move', debounce(saveBounds, 400));
  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    if (code === -3) return; // 用户主动中断
    dialog.showMessageBox({
      type: 'error',
      message: '页面加载失败',
      detail: `${desc} (${code})\n本地服务端口：${serverPort}`,
      buttons: ['重新载入', '退出'],
    }).then((r) => { if (r.response === 0) mainWindow.reload(); else app.quit(); });
  });
}

function showMain() {
  if (!mainWindow) { createMainWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/* ==================================================================
   迷你播放器
   ================================================================== */

const MINI_SIZE = { width: 520, height: 132 };

function miniStateFile() {
  return path.join(app.getPath('userData'), 'mini-state.json');
}

function createMiniWindow() {
  if (miniWindow && !miniWindow.isDestroyed()) { miniWindow.show(); miniWindow.focus(); return; }

  const saved = readJSON(miniStateFile(), null);
  const area = screen.getPrimaryDisplay().workArea;
  const x = saved && Number.isFinite(saved.x) ? saved.x : Math.round(area.x + area.width - MINI_SIZE.width - 28);
  const y = saved && Number.isFinite(saved.y) ? saved.y : Math.round(area.y + 64);

  miniWindow = new BrowserWindow({
    width: MINI_SIZE.width,
    height: MINI_SIZE.height,
    x,
    y,
    minWidth: 360,
    minHeight: MINI_SIZE.height,
    maxHeight: MINI_SIZE.height,
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: '#101318',
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    roundedCorners: true,
    hasShadow: true,
    skipTaskbar: true,
    title: '闻曲 · 迷你播放器',
    webPreferences: {
      preload: path.join(__dirname, 'mini-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  miniWindow.loadFile(path.join(__dirname, 'mini.html'));
  miniWindow.setAlwaysOnTop(miniAlwaysOnTop, 'floating');
  miniWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  miniWindow.once('ready-to-show', () => {
    miniWindow.show();
    miniWindow.webContents.send('mini:state', playState);
    syncMiniWindowMenu();
  });

  miniWindow.on('moved', () => {
    clearTimeout(miniBoundsTimer);
    miniBoundsTimer = setTimeout(() => {
      if (miniWindow && !miniWindow.isDestroyed()) writeJSON(miniStateFile(), miniWindow.getBounds());
    }, 400);
  });

  miniWindow.on('closed', () => {
    miniWindow = null;
    if (tray) rebuildTrayMenu();
  });
}

function toggleMini() {
  if (miniWindow && !miniWindow.isDestroyed()) miniWindow.close();
  else createMiniWindow();
  if (tray) rebuildTrayMenu();
}

function syncMiniWindowMenu() {
  if (!miniWindow || miniWindow.isDestroyed()) return;
  miniWindow.webContents.send('mini:flags', { alwaysOnTop: miniAlwaysOnTop });
}

/* ==================================================================
   状态广播
   ================================================================== */

function broadcastState(state) {
  Object.assign(playState, state || {});
  if (miniWindow && !miniWindow.isDestroyed()) miniWindow.webContents.send('mini:state', playState);
  if (tray) rebuildTrayMenu();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitle(playState.name ? `${playState.name} — ${APP_NAME}` : APP_NAME);
  }
}

function sendCommand(cmd, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ew:command', { cmd, payload });
  }
}

/* ==================================================================
   托盘 / Dock / 菜单
   ================================================================== */

function trayIcon() {
  const candidates = [
    path.join(__dirname, '..', 'build', 'trayTemplate.png'),
    path.join(__dirname, '..', 'build', 'trayTemplate@2x.png'),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      const img = nativeImage.createFromPath(file);
      if (!img.isEmpty()) return img;
    }
  }
  return null;
}

function rebuildTrayMenu() {
  if (!tray) return;
  const playingLabel = playState.name ? `${playState.name}${playState.artist ? ' · ' + playState.artist : ''}` : '未在播放';
  const template = [
    { label: playingLabel, enabled: false },
    { type: 'separator' },
    { label: playState.playing ? '暂停' : '播放', click: () => sendCommand('toggle') },
    { label: '上一首', click: () => sendCommand('prev') },
    { label: '下一首', click: () => sendCommand('next') },
    { type: 'separator' },
    { label: '显示闻曲', click: showMain },
    { label: miniWindow && !miniWindow.isDestroyed() ? '关闭迷你播放器' : '迷你播放器', click: toggleMini },
    { type: 'separator' },
    { label: '退出闻曲', click: () => { quitting = true; app.quit(); } },
  ];
  tray.setToolTip(playState.name ? `闻曲 · ${playingLabel}` : '闻曲 Earworm');
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createTray() {
  const img = trayIcon();
  if (!img) return; // 没有图标就不做托盘，不影响主功能
  tray = new Tray(img);
  tray.setIgnoreDoubleClickEvents(true);
  tray.on('click', () => {
    if (process.platform === 'darwin' && tray) tray.popUpContextMenu();
  });
  rebuildTrayMenu();
}

function createDockMenu() {
  if (!app.dock) return;
  app.dock.setMenu(Menu.buildFromTemplate([
    { label: '播放 / 暂停', click: () => sendCommand('toggle') },
    { label: '上一首', click: () => sendCommand('prev') },
    { label: '下一首', click: () => sendCommand('next') },
    { type: 'separator' },
    { label: '迷你播放器', click: toggleMini },
  ]));
}

/* ==================================================================
   IPC
   ================================================================== */

function registerIpc() {
  ipcMain.on('ew:state', (_e, state) => broadcastState(state));

  ipcMain.on('ew:mini-command', (_e, cmd) => sendCommand(cmd));

  ipcMain.on('ew:mini-action', (_e, action) => {
    if (action === 'close') { if (miniWindow) miniWindow.close(); rebuildTrayMenu(); return; }
    if (action === 'open-main') { showMain(); return; }
    if (action === 'pin') {
      miniAlwaysOnTop = !miniAlwaysOnTop;
      if (miniWindow) miniWindow.setAlwaysOnTop(miniAlwaysOnTop, 'floating');
      syncMiniWindowMenu();
      return;
    }
    sendCommand(action);
  });

  ipcMain.on('ew:mini-seek', (_e, ratio) => sendCommand('seek-ratio', ratio));
  ipcMain.handle('ew:mini-state', () => playState);
  ipcMain.handle('ew:app-info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    serverPort,
    dataDir: DATA_DIR,
  }));
  ipcMain.on('ew:open-external', (_e, url) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
  ipcMain.on('ew:show-main', showMain);
  ipcMain.on('ew:toggle-mini', toggleMini);
}

/* ==================================================================
   全局快捷键 / 菜单栏
   ================================================================== */

function registerShortcuts() {
  const bind = (accel, cmd) => {
    try { globalShortcut.register(accel, () => sendCommand(cmd)); } catch { /* 被系统占用 */ }
  };
  bind('MediaPlayPause', 'toggle');
  bind('MediaNextTrack', 'next');
  bind('MediaPreviousTrack', 'prev');
}

function buildAppMenu() {
  const { buildMenu } = require('./menu');
  Menu.setApplicationMenu(buildMenu({
    appName: APP_NAME,
    sendCommand,
    toggleMini,
    showMain,
    openExternal: (url) => shell.openExternal(url),
    getMiniOpen: () => !!(miniWindow && !miniWindow.isDestroyed()),
  }));
}

/* ==================================================================
   生命周期
   ================================================================== */

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMain());

  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    version: `Electron ${process.versions.electron}`,
    copyright: 'GPL-3.0-only · 衍生自 Mineradio',
    credits: '国风沉浸式音乐播放器 · 听曲知雅意',
  });

  // 汽水扫码登录需要在隐藏窗口里跑官方 SDK：给这个分区一个桌面 UA
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
  });

  app.whenReady().then(async () => {
    nativeTheme.themeSource = 'dark';

    try {
      await startServer();
    } catch (err) {
      dialog.showErrorBox('闻曲无法启动', `本地音源服务启动失败：\n${err.message}`);
      app.exit(1);
      return;
    }

    registerIpc();
    createMainWindow();
    createTray();
    createDockMenu();
    buildAppMenu();
    registerShortcuts();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
      else showMain();
    });
  });

  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  // 音乐应用：所有窗口关闭也不退出，留在菜单栏
  app.on('window-all-closed', () => { /* 保持运行，等待 Dock / 菜单栏唤回 */ });
}
