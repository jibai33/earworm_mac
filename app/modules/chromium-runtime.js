'use strict';

// ====================================================================
//  Chromium 运行时（替代 Electron 的隐藏 BrowserWindow）
//  汽水音乐签名引擎 qishui-auth-v6.js 原本跑在 Electron 的隐藏窗口里，
//  依赖 BrowserWindow / session.webRequest 拦截来注入官方 BDMS SDK 与
//  捕获 a_bogus 签名。这里用本机 Chrome + CDP 提供等价接口，
//  让纯 Node 的 Web 服务也能完成抖音 App 扫码登录。
//
//  优先顺序由 electron-runtime.js 决定：真实 Electron > 本机 Chrome。
// ====================================================================
const fs = require('fs');

function findChrome() {
  const candidates = [
    process.env.EW_CHROME_PATH,
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  return candidates.find(p => p && fs.existsSync(p)) || '';
}

/* Electron webRequest 的 URL 匹配模式 → 正则 */
function urlMatches(pattern, url) {
  if (!pattern) return false;
  if (pattern === '<all_urls>') return true;
  const escaped = String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  try { return new RegExp('^' + escaped.replace(/\*/g, '.*') + '$').test(url); }
  catch { return false; }
}
const matchesAny = (patterns, url) => (patterns || []).some(p => urlMatches(p, url));

/* session.webRequest 的钩子先登记，BrowserWindow 启动时再挂到 CDP */
const hooks = {
  onBeforeRequest: [], onHeadersReceived: [], onBeforeSendHeaders: [],
  onCompleted: [], onErrorOccurred: [],
};

function fire(list, details, onResult) {
  for (const h of list) {
    if (!matchesAny(h.filter && h.filter.urls, details.url)) continue;
    try { h.cb(details, onResult || (() => {})); } catch { /* 单个钩子异常不影响请求 */ }
  }
}

async function attachHooks(page) {
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const url = req.url();
    try {
      const details = { url, method: req.method(), requestHeaders: req.headers() };
      let redirect = null;
      fire(hooks.onBeforeRequest, details, (r) => { if (r && r.redirectURL) redirect = r.redirectURL; });
      // 跨域响应头改写由启动参数 --disable-web-security 承担，这里只派发事件
      fire(hooks.onHeadersReceived, { url, responseHeaders: {} }, () => {});
      fire(hooks.onBeforeSendHeaders, details, () => {});
      if (redirect) { await req.continue({ url: redirect }); return; }
      await req.continue();
    } catch {
      try { await req.abort(); } catch { /* 已处理 */ }
    }
  });
  const finish = (list, req) => {
    const resp = req.response && req.response();
    let error = '';
    try { error = (req.failure && (req.failure() || {}).errorText) || ''; } catch { /* ignore */ }
    fire(list, {
      url: req.url(), method: req.method(),
      statusCode: resp ? resp.status() : 0,
      error,
    });
  };
  page.on('requestfinished', (req) => finish(hooks.onCompleted, req));
  page.on('requestfailed', (req) => finish(hooks.onErrorOccurred, req));
}

const authSession = {
  webRequest: Object.fromEntries(Object.keys(hooks).map((name) => [
    name, (filter, cb) => { hooks[name].push({ filter, cb }); },
  ])),
  // headless 每次启动都是全新 profile，销毁窗口即等于清空存储
  clearStorageData: async () => {},
  flushStorageData: async () => {},
  get cookies() { return {}; },
};

class ChromiumWindow {
  constructor(options) {
    this.options = options || {};
    this._ua = '';
    this._destroyed = false;
    this._page = null;
    this._browser = null;
    this._handlers = {};
    this._ready = this._boot();
    this.webContents = {
      setUserAgent: (ua) => { this._ua = ua; return this._ready.then(p => p.setUserAgent(ua)); },
      executeJavaScript: (code) => this._ready.then(p => p.evaluate(code)),
    };
  }

  async _boot() {
    let puppeteer;
    try { puppeteer = require('puppeteer-core'); }
    catch {
      throw new Error('缺少 puppeteer-core，无法在纯 Node 环境启动汽水签名引擎（npm install 后重试）');
    }
    const executablePath = findChrome();
    if (!executablePath) {
      throw new Error('没找到本机 Chrome / Chromium。设置 EW_CHROME_PATH 指向浏览器可执行文件后重试');
    }
    this._browser = await puppeteer.launch({
      executablePath,
      headless: 'new',
      args: [
        '--no-sandbox', '--no-first-run', '--no-default-browser-check',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-site-isolation-trials',
        '--enable-unsafe-swiftshader',
      ],
    });
    const page = await this._browser.newPage();
    await page.setViewport({
      width: this.options.width || 980,
      height: this.options.height || 760,
    });
    if (this._ua) await page.setUserAgent(this._ua);
    await attachHooks(page);
    this._page = page;
    return page;
  }

  async loadURL(url) {
    const page = await this._ready;
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  }

  on(event, cb) { this._handlers[event] = cb; return this; }
  setMenuBarVisibility() {}
  setTitle() {}
  setSize() {}
  center() {}
  show() {}
  hide() {}
  focus() {}
  isDestroyed() { return this._destroyed; }
  async destroy() {
    this._destroyed = true;
    try { await this._ready; } catch { /* 启动失败也要清理 */ }
    try { if (this._browser) await this._browser.close(); } catch { /* ignore */ }
    this._page = null; this._browser = null;
    for (const list of Object.values(hooks)) list.length = 0;
  }
}

const app = {
  isReady: () => true,
  whenReady: async () => {},
  getPath: () => require('os').tmpdir(),
  quit: () => {},
};

module.exports = { BrowserWindow: ChromiumWindow, app, session: { fromPartition: () => authSession } };
module.exports.findChrome = findChrome;
