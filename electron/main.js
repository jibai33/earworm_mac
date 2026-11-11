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
const { renderTrayBitmap } = require('./tray-icon');

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
let trayMenu = null;
let serverPort = 0;
let quitting = false;
let miniAlwaysOnTop = true;
let miniBoundsTimer = null;
let miniPopover = false;   // 从菜单栏点开：失焦自动收起
let miniPinned = false;    // 常驻：失焦也不收起
let miniOpenedAt = 0;
let trayBandsKey = '';

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

function miniAlive() { return !!(miniWindow && !miniWindow.isDestroyed()); }

function miniStateFile() {
  return path.join(app.getPath('userData'), 'mini-state.json');
}

/** 把弹层摆在菜单栏图标正下方，并夹在屏幕可用区域内 */
function positionMiniUnderTray() {
  if (!miniAlive() || !tray) return;
  const tb = tray.getBounds();
  const area = screen.getDisplayNearestPoint({ x: tb.x, y: tb.y }).workArea;
  const { width, height } = miniWindow.getBounds();
  let x = Math.round(tb.x + tb.width / 2 - width / 2);
  x = Math.max(area.x + 8, Math.min(area.x + area.width - width - 8, x));
  const y = Math.round(Math.min(area.y + area.height - height - 8, tb.y + tb.height + 6));
  miniWindow.setPosition(x, y);
}

function createMiniWindow(popover) {
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
      backgroundThrottling: false,
    },
  });

  miniWindow.loadFile(path.join(__dirname, 'mini.html'));
  miniWindow.setAlwaysOnTop(miniAlwaysOnTop, 'floating');
  miniWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  miniWindow.once('ready-to-show', () => {
    if (popover) positionMiniUnderTray();
    miniWindow.show();
    miniOpenedAt = Date.now();
    miniWindow.webContents.send('mini:state', playState);
    syncMiniWindowMenu();
  });

  // 弹层行为：点别处就收起（拖动窗口的 300ms 内不判定，避免刚打开就被 blur 掉）
  miniWindow.on('blur', () => {
    if (!miniPopover || miniPinned) return;
    if (Date.now() - miniOpenedAt < 300) return;
    miniWindow.hide();
  });

  miniWindow.on('moved', () => {
    clearTimeout(miniBoundsTimer);
    miniBoundsTimer = setTimeout(() => {
      if (miniWindow && !miniWindow.isDestroyed()) writeJSON(miniStateFile(), miniWindow.getBounds());
    }, 400);
  });

  miniWindow.on('closed', () => {
    miniWindow = null;
    miniPopover = false;
    if (tray) rebuildTrayMenu();
  });
}

function showMini(opts) {
  const popover = !(opts && opts.popover === false);
  if (miniAlive()) {
    miniPopover = popover;
    if (popover) positionMiniUnderTray();
    miniWindow.show();
    miniWindow.focus();
    miniOpenedAt = Date.now();
    return;
  }
  miniPopover = popover;
  createMiniWindow(popover);
}

function hideMini() {
  if (miniAlive()) miniWindow.hide();
}

function toggleMini(fromTray) {
  const open = miniAlive() && miniWindow.isVisible();
  if (open) hideMini();
  else showMini({ popover: !!fromTray });
  if (tray) rebuildTrayMenu();
}

function syncMiniWindowMenu() {
  if (!miniAlive()) return;
  miniWindow.webContents.send('mini:flags', { alwaysOnTop: miniAlwaysOnTop, pinned: miniPinned });
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

/**
 * 菜单栏频谱：把渲染层送来的 8 段音量画成模板图。
 * 按量化后的形状做去重，静止时不做任何 setImage，避免菜单栏每帧重绘。
 */
function applyTrayBands(bands) {
  if (!tray) return;
  const key = bands
    ? bands.map((v) => Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 8)).join('')
    : 'pause';
  if (key === trayBandsKey) return;
  trayBandsKey = key;
  try {
    const { buffer, width, height } = renderTrayBitmap(bands);
    const img = nativeImage.createFromBitmap(buffer, { width, height, scaleFactor: 2 });
    img.setTemplateImage(true);
    tray.setImage(img);
  } catch { /* 生成失败就保持上一个图标，不影响播放 */ }
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
    { label: '迷你播放器', click: () => showMini({ popover: false }) },
    { type: 'separator' },
    { label: '退出闻曲', click: () => { quitting = true; app.quit(); } },
  ];
  trayMenu = Menu.buildFromTemplate(template);
  tray.setToolTip(playState.name ? `闻曲 · ${playingLabel}` : '闻曲 Earworm');
}

function createTray() {
  const img = trayIcon();
  if (!img) return; // 没有图标就不做托盘，不影响主功能
  tray = new Tray(img);
  tray.setIgnoreDoubleClickEvents(true);
  // 左键：展开面板；右键：菜单。注意不要 setContextMenu，否则 macOS 会把左键也吃掉
  tray.on('click', () => toggleMini(true));
  tray.on('right-click', () => { if (trayMenu) tray.popUpContextMenu(trayMenu); });
  applyTrayBands(null);
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
    if (action === 'hide') { hideMini(); rebuildTrayMenu(); return; }
    if (action === 'open-main') { showMain(); return; }
    if (action === 'pin') {
      // 常驻：失焦不再收起，方便边干别的边看播放条
      miniPinned = !miniPinned;
      if (miniPinned) miniPopover = false;
      syncMiniWindowMenu();
      return;
    }
    sendCommand(action);
  });

  // 菜单栏频谱：渲染层每 ~70ms 上报一次 8 段音量，null 表示未播放
  ipcMain.on('ew:spectrum', (_e, bands) => {
    const list = Array.isArray(bands) && bands.length ? bands.slice(0, 8) : null;
    applyTrayBands(list);
    if (miniAlive()) miniWindow.webContents.send('mini:spectrum', list);
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
  // 重复打开只唤起主窗口，不产生第二个实例
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

    // 开发模式（npx electron .）Dock 上会挂 Electron 默认图标，手动换成自己的
    if (process.platform === 'darwin' && app.dock) {
      try {
        const devIcon = path.join(__dirname, '..', 'build', 'icon.png');
        if (fs.existsSync(devIcon)) app.dock.setIcon(nativeImage.createFromPath(devIcon));
      } catch { /* 图标缺失不影响启动 */ }
    }

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
