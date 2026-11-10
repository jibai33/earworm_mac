'use strict';

// Focused authentication port from Wx2yZx/Mineradio-Qishui-QR-Login
// revision aaadaab7d011714f94fbe45b382ba8dcc7cf17b9 (GPL-3.0-only).
// This module intentionally owns only the official Passport Web QR flow.
// Mineradio's catalogue, playlist and playback adapters remain in qishui-api.js.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
// 原生 Electron（mac 端）优先；纯 Web 服务下由本机 Chrome 提供等价的隐藏窗口
const { BrowserWindow, app, session } = require('./electron-runtime');
const QRCode = require('qrcode');

const API_BASE = 'https://api.qishui.com';
const AID = '386088';
const APP_VERSION = '3.5.2';
const SDK_VERSION = '2.4.13';
const VERIFY_SDK_VERSION = '1.0.29';
const SECURE_SDK_VERSION = '3.3.5';
const BDMS_VERSION = '1.0.0.41';
const AUTH_PARTITION = 'persist:mineradio-qishui-auth-v6';
const OFFICIAL_BDMS_URL =
  'https://lf-headquarters-speed.yhgfb-cn-static.com/obj/rc-client-security/web/stable/1.0.0.41/bdms.js';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) SodaMusic/3.2.1 Chrome/136.0.7103.59 ' +
  'Electron/36.4.0-rs.22.release.main.1 TTElectron/36.4.0-rs.22.release.main.1 Safari/537.36';

const ASSET_DIR = path.join(__dirname, 'qishui-auth-v6');
const ASSETS = new Map([
  ['security_seed.html', 'text/html; charset=utf-8'],
  ['security_host.html', 'text/html; charset=utf-8'],
  ['react.js', 'text/javascript; charset=utf-8'],
  ['react-dom.js', 'text/javascript; charset=utf-8'],
  ['sdk-glue.js', 'text/javascript; charset=utf-8'],
  ['bdms.js', 'text/javascript; charset=utf-8'],
]);

let getConfig = null;
let updateConfig = null;
let runtime = null;

function configure(hooks) {
  getConfig = hooks && hooks.getConfig;
  updateConfig = hooks && hooks.updateConfig;
}

function randomDigits(length, firstMax = 9) {
  let value = String(crypto.randomInt(1, Math.max(2, firstMax + 1)));
  while (value.length < length) value += String(crypto.randomInt(0, 10));
  return value;
}

function ensureIdentity() {
  if (typeof getConfig !== 'function' || typeof updateConfig !== 'function') {
    throw new Error('Qishui V6 auth runtime is not configured');
  }
  const config = getConfig();
  const patch = {};
  if (!config.deviceId) patch.deviceId = randomDigits(16, 8);
  if (!config.installId) patch.installId = randomDigits(15, 8);
  if (!config.verifyPortraitId) patch.verifyPortraitId = crypto.randomUUID() + '.login';
  if (!config.computerName) patch.computerName = os.hostname() || 'Windows-PC';
  if (Object.keys(patch).length) updateConfig(patch);
  const current = getConfig();
  return {
    deviceId: String(current.deviceId),
    installId: String(current.installId),
    verifyPortraitId: String(current.verifyPortraitId),
    computerName: String(current.computerName || 'Windows-PC'),
  };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeBizParams(value) {
  if (!value) return {};
  let source = value;
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source);
    } catch (_) {
      const parsed = new URLSearchParams(source);
      return Object.fromEntries(parsed.entries());
    }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('二次验证 biz_params 格式无效');
  }
  const result = {};
  for (const [key, item] of Object.entries(source)) {
    if (item == null) continue;
    result[String(key)] = typeof item === 'object' ? JSON.stringify(item) : String(item);
  }
  return result;
}

function mergeDecision(envelope) {
  const data = envelope && envelope.data && typeof envelope.data === 'object' ? envelope.data : {};
  const decision = { ...(envelope || {}), ...data };
  delete decision.data;
  return decision;
}

function officialScanUrl(indexUrl, computerName) {
  const source = new URL(String(indexUrl || ''));
  const token = source.searchParams.get('token');
  if (!token) throw new Error('qrcode_index_url 缺少 token');
  const target = new URL('https://bff-pc.qishui.com/light/invoke/scan_login');
  target.searchParams.set('token', token);
  target.searchParams.set('os', 'Windows');
  target.searchParams.set('computer_name', computerName || 'Windows-PC');
  return target.toString().replace(/\+/g, '%20');
}

function parseCookieString(raw) {
  const result = {};
  String(raw || '').split(';').forEach(pair => {
    const index = pair.indexOf('=');
    if (index > 0) result[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
  });
  return result;
}

// 登录票据以 Set-Cookie 响应头下发，隐藏窗口里是跨域 XHR：Chromium 会丢掉
// 这些 cookie，JS 端的 getAllResponseHeaders() 也读不到（forbidden header）。
// 因此必须在 Electron 原生响应头这一层把它们截下来。
const COOKIE_ATTR_NAMES = new Set([
  'path', 'domain', 'expires', 'max-age', 'httponly', 'secure',
  'samesite', 'priority', 'partitioned', 'samesiteparty',
]);
const LOGIN_COOKIE_RE = /^(sessionid|sessionid_ss|sid_guard|sid_tt|uid_tt|uid_tt_ss|sid_tt_ss|ssid_ucp_v1)$/i;

function parseSetCookieValues(headers) {
  const out = new Map();
  const lines = [];
  if (Array.isArray(headers)) {
    for (const line of headers) lines.push(String(line));
  } else {
    for (const [key, value] of Object.entries(headers || {})) {
      if (String(key).toLowerCase() !== 'set-cookie') continue;
      for (const line of (Array.isArray(value) ? value : [value])) lines.push(String(line));
    }
  }
  for (const line of lines) {
    // 一个 Set-Cookie 头只含一个 cookie；取分号前第一段即可，后面的都是属性
    const first = String(line).split(';')[0];
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (!name || COOKIE_ATTR_NAMES.has(name.toLowerCase())) continue;
    out.set(name, value);
  }
  return out;
}

// 有些版本的接口把票据放在响应体里，字段名不固定，递归扫一遍 cookie 形态的字符串
function collectCookieLikeStrings(value, out, depth = 0) {
  if (depth > 6 || out.length > 30) return;
  if (typeof value === 'string') {
    if (/(?:^|;\s*)(?:sessionid|sessionid_ss|sid_guard|sid_tt|uid_tt|uid_tt_ss)\s*=/i.test(value)) out.push(value);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const item of Object.values(value)) collectCookieLikeStrings(item, out, depth + 1);
}

function buildCookieString(values) {
  return Object.entries(values)
    .filter(([name]) => name)
    .map(([name, value]) => name + '=' + value)
    .join('; ');
}

class QishuiAuthRuntime {
  constructor() {
    this.window = null;
    this.authSession = null;
    this.assetServer = null;
    this.assetBase = '';
    this.assetToken = crypto.randomBytes(18).toString('hex');
    this.msToken = '';
    this.browserInfo = null;
    this.lastPassportRequest = null;
    this.initializing = null;
    this.destroying = false;
    this.mfaNetworkLog = [];
    this.qrGeneration = 0;
    // 从原生响应头截获的 Set-Cookie（跨域 XHR 不会写进 Electron 的 cookie jar）
    this.capturedCookieJar = new Map();
    this.lastCookieCapture = null;
  }

  async initialize() {
    if (this.window && !this.window.isDestroyed() && this.browserInfo && this.msToken) return true;
    if (this.initializing) return this.initializing;
    this.initializing = this._initialize().finally(() => { this.initializing = null; });
    return this.initializing;
  }

  async _startAssetServer() {
    if (this.assetServer) return;
    this.assetServer = http.createServer((request, response) => {
      try {
        const url = new URL(request.url, 'http://127.0.0.1');
        const prefix = '/' + this.assetToken + '/';
        if (!url.pathname.startsWith(prefix)) {
          response.writeHead(404).end('not found');
          return;
        }
        const name = url.pathname.slice(prefix.length);
        const type = ASSETS.get(name);
        if (!type) {
          response.writeHead(404).end('not found');
          return;
        }
        const file = path.join(ASSET_DIR, name);
        if (!fs.existsSync(file)) {
          response.writeHead(500).end('missing auth asset');
          return;
        }
        response.writeHead(200, {
          'Content-Type': type,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        fs.createReadStream(file).pipe(response);
      } catch (_) {
        response.writeHead(500).end('asset error');
      }
    });
    await new Promise((resolve, reject) => {
      this.assetServer.once('error', reject);
      this.assetServer.listen(0, '127.0.0.1', resolve);
    });
    const address = this.assetServer.address();
    this.assetBase = `http://127.0.0.1:${address.port}/${this.assetToken}/`;
  }

  _installSessionHooks() {
    // session 是同一个持久 partition，重复初始化会让 listener 越堆越多
    if (this._hooksInstalled) return;
    this._hooksInstalled = true;
    const authSession = this.authSession;
    authSession.webRequest.onBeforeRequest(
      { urls: [OFFICIAL_BDMS_URL] },
      (_details, callback) => callback({ redirectURL: this.assetBase + 'bdms.js' }),
    );
    // CORS 注入与 Set-Cookie 截获必须放在同一个监听器里：Electron 的
    // webRequest 对同一事件只保留最后一个 listener，注册两个会把前者挤掉。
    // 过滤器放宽到所有请求，因为登录票据可能由 qishui / douyin / zijieapi /
    // snssdk 等任一域下发；CORS 头仍然只给官方接口加。
    const corsOrigins = /^https:\/\/(?:api\.qishui\.com|verify\.zijieapi\.com|auth\.zijieapi\.com)\//;
    authSession.webRequest.onHeadersReceived(
      { urls: ['*://*/*'] },
      (details, callback) => {
        const headers = { ...(details.responseHeaders || {}) };
        try {
          const captured = parseSetCookieValues(details.responseHeaders);
          if (captured.size) {
            for (const [name, value] of captured) this.capturedCookieJar.set(name, value);
            this.lastCookieCapture = {
              at: Date.now(),
              names: [...captured.keys()],
              endpoint: this.safeEndpoint(details.url),
            };
          }
        } catch (error) {
          console.warn('[QishuiAuth] Set-Cookie 截获失败:', error && error.message || error);
        }
        if (corsOrigins.test(String(details.url || ''))) {
          // 原响应头里可能已有小写键，先删掉再加，避免同名头出现两份
          for (const key of Object.keys(headers)) {
            const lower = String(key).toLowerCase();
            if (lower === 'access-control-allow-origin' || lower === 'access-control-expose-headers') delete headers[key];
          }
          headers['Access-Control-Allow-Origin'] = ['*'];
          headers['Access-Control-Expose-Headers'] = ['*'];
        }
        callback({ responseHeaders: headers });
      },
    );
    authSession.webRequest.onBeforeSendHeaders(
      { urls: ['https://api.qishui.com/passport/*'] },
      (details, callback) => {
        this.lastPassportRequest = {
          method: details.method,
          url: details.url,
          requestHeaders: details.requestHeaders,
        };
        callback({ requestHeaders: details.requestHeaders });
      },
    );
    const mfaUrls = ['https://api.qishui.com/passport/*', 'https://verify.zijieapi.com/passport/*'];
    authSession.webRequest.onCompleted({ urls: mfaUrls }, details => {
      this.mfaNetworkLog.push({ at: Date.now(), method: details.method, endpoint: this.safeEndpoint(details.url), statusCode: details.statusCode });
      if (this.mfaNetworkLog.length > 100) this.mfaNetworkLog.shift();
    });
    authSession.webRequest.onErrorOccurred({ urls: mfaUrls }, details => {
      this.mfaNetworkLog.push({ at: Date.now(), method: details.method, endpoint: this.safeEndpoint(details.url), error: details.error });
      if (this.mfaNetworkLog.length > 100) this.mfaNetworkLog.shift();
    });
  }

  safeEndpoint(rawUrl) {
    try {
      const value = new URL(rawUrl);
      return value.origin + value.pathname;
    } catch (_) {
      return String(rawUrl || '').split('?')[0];
    }
  }

  async _initialize() {
    if (!app.isReady()) await app.whenReady();
    ensureIdentity();
    await this._startAssetServer();
    this.authSession = session.fromPartition(AUTH_PARTITION);
    this._installSessionHooks();
    this.window = new BrowserWindow({
      show: false,
      width: 980,
      height: 760,
      minWidth: 760,
      minHeight: 600,
      title: '汽水音乐安全验证',
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      webPreferences: {
        partition: AUTH_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: false,
        backgroundThrottling: false,
      },
    });
    this.window.setMenuBarVisibility(false);
    this.window.webContents.setUserAgent(UA);
    this.window.on('close', event => {
      if (this.destroying) return;
      event.preventDefault();
      this.window.webContents.executeJavaScript(
        'window.__qishuiCancelSecondVerify && window.__qishuiCancelSecondVerify()',
      ).catch(() => {});
      this.window.hide();
    });

    await this.window.loadURL(this.assetBase + 'security_seed.html');
    let storedToken = await this.window.webContents.executeJavaScript(
      `localStorage.getItem('xmsty') || localStorage.getItem('xmst') || ''`,
      true,
    );
    if (!/^[A-Za-z0-9_-]{118}==$/.test(String(storedToken || ''))) {
      storedToken = crypto.randomBytes(88).toString('base64url') + '==';
    }
    this.msToken = String(storedToken);
    await this.window.webContents.executeJavaScript(
      `localStorage.setItem('xmst', ${JSON.stringify(this.msToken)});
       localStorage.setItem('xmsty', ${JSON.stringify(this.msToken)}); true`,
      true,
    );
    await this.window.loadURL(this.assetBase + 'security_host.html');
    await this.waitForBdms();
    this.browserInfo = await this.window.webContents.executeJavaScript('window.__qishuiBrowserInfo()', true);
    updateConfig({ msToken: this.msToken });
    return true;
  }

  async waitForBdms(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await this.window.webContents.executeJavaScript(`({
        glue: window._sdkGlueVersionMap && window._sdkGlueVersionMap.sdkGlueVersion,
        bdms: window._sdkGlueVersionMap && window._sdkGlueVersionMap.bdmsVersion,
        loaded: Boolean(window.bdms)
      })`);
      if (last && last.loaded && last.bdms) return last;
      await delay(100);
    }
    throw new Error('汽水安全组件初始化超时：bdms 1.0.0.41 未就绪');
  }

  commonParams(identity) {
    return {
      passport_jssdk_version: SDK_VERSION,
      passport_jssdk_type: 'normal',
      is_from_ttaccountsdk: '1',
      aid: AID,
      language: 'zh',
      account_sdk_source: 'web',
      p_js_v: SDK_VERSION,
      p_js_t: 'pro',
      p_zt: SECURE_SDK_VERSION,
      p_ver: VERIFY_SDK_VERSION,
      request_host: 'app%3A%2F%2Fresources',
      p_bd: BDMS_VERSION,
      biz_trace_id: crypto.randomBytes(4).toString('hex'),
      is_new_login: '1',
      is_from_iesaccountsaas: '1',
      device_id: identity.deviceId,
      install_id: identity.installId,
      did: identity.deviceId,
      iid: identity.installId,
      device_platform: 'PC',
      version_code: APP_VERSION,
      account_sdk_source_info: String(this.browserInfo.encrypted),
      msToken: this.msToken,
    };
  }

  requestHeaders(identity, bizTraceId) {
    const traceId = crypto.randomBytes(16).toString('hex');
    return {
      Accept: 'application/json, text/javascript',
      'User-Agent': UA,
      'x-tt-passport-verify-portrait': identity.verifyPortraitId,
      'x-tt-passport-trace-id': bizTraceId,
      'x-tt-trace-id': `00-${traceId}-${traceId.slice(0, 16)}-01`,
    };
  }

  async request(method, pathname, params, data) {
    await this.initialize();
    const identity = ensureIdentity();
    const query = { ...this.commonParams(identity), ...(params || {}) };
    const url = new URL(pathname, API_BASE);
    for (const [name, value] of Object.entries(query)) {
      if (value != null) url.searchParams.set(name, String(value));
    }
    const headers = this.requestHeaders(identity, query.biz_trace_id);
    let body = null;
    if (data != null) {
      body = new URLSearchParams();
      for (const [name, value] of Object.entries(data)) {
        if (value != null) body.set(name, typeof value === 'object' ? JSON.stringify(value) : String(value));
      }
      body = body.toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['x-ss-stub'] = crypto.createHash('md5').update(body).digest('hex').toUpperCase();
    }
    const payload = {
      method: String(method || 'GET').toUpperCase(),
      url: url.toString(),
      headers,
      body,
      timeout: 30000,
    };
    const response = await this.window.webContents.executeJavaScript(
      `window.__qishuiRequest(${JSON.stringify(payload)})`,
      true,
    );
    if (!response || response.status < 200 || response.status >= 400) {
      throw new Error(`汽水登录接口 HTTP ${response && response.status || 0}: ${String(response && response.body || '').slice(0, 300)}`);
    }
    let envelope;
    try {
      envelope = JSON.parse(response.body || '{}');
    } catch (_) {
      throw new Error('汽水登录接口返回了无效 JSON');
    }
    const signedUrl = String(this.lastPassportRequest && this.lastPassportRequest.url || '');
    let signedQuery;
    try {
      signedQuery = new URL(signedUrl).searchParams;
    } catch (_) {
      signedQuery = new URLSearchParams();
    }
    const aBogus = signedQuery.get('a_bogus') || '';
    const signedMsToken = signedQuery.get('msToken') || '';
    if (aBogus.length !== 44 || signedMsToken !== this.msToken) {
      throw new Error('汽水安全参数注入失败：a_bogus 或 msToken 缺失');
    }
    // 跨域 XHR 读不到 Set-Cookie，但其它响应头对排查凭据问题有用
    envelope.__responseHeaders = String(response.headers || '');
    return envelope;
  }

  async getQrCode() {
    this.qrGeneration += 1;
    await this.initialize();
    const identity = ensureIdentity();
    const envelope = await this.request('GET', '/passport/web/get_qrcode/', {
      next: API_BASE,
      need_logo: 'false',
      need_short_url: 'false',
    });
    const data = envelope.data || {};
    if (envelope.message !== 'success' || Number(data.error_code) !== 0) {
      throw new Error(`二维码生成失败：code=${data.error_code} ${data.description || envelope.message || ''}`);
    }
    const scanUrl = officialScanUrl(data.qrcode_index_url, identity.computerName);
    const qrDataUrl = await QRCode.toDataURL(scanUrl, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 360,
      color: { dark: '#000000', light: '#ffffff' },
    });
    envelope.data = { ...data, qrcode: qrDataUrl, scan_url: scanUrl };
    return envelope;
  }

  async secondVerify(decision, identity) {
    this.mfaNetworkLog = [];
    this.window.setTitle('汽水音乐安全验证');
    this.window.setSize(980, 760);
    this.window.center();
    this.window.show();
    this.window.focus();
    try {
      return await this.window.webContents.executeJavaScript(
        `window.__qishuiSecondVerify(
          ${JSON.stringify(decision)},
          ${JSON.stringify({ generalParams: {
            device_id: identity.deviceId,
            install_id: identity.installId,
            did: identity.deviceId,
            iid: identity.installId,
            device_platform: 'PC',
            version_code: APP_VERSION,
          } })}
        )`,
        true,
      );
    } finally {
      if (this.window && !this.window.isDestroyed()) this.window.hide();
    }
  }

  async checkQrConnect(token) {
    await this.initialize();
    const identity = ensureIdentity();
    const body = {
      need_logo: 'false',
      need_short_url: 'false',
      is_frontier: 'true',
      token: String(token || ''),
      is_new_login: '1',
      next: API_BASE,
    };
    let envelope = await this.request('POST', '/passport/web/check_qrconnect/', {}, body);
    let data = envelope.data || {};
    if (Number(data.error_code) === 2046) {
      const decision = mergeDecision(envelope);
      if (!decision.verify_portrait_id) decision.verify_portrait_id = identity.verifyPortraitId;
      const bizParams = normalizeBizParams(decision.biz_params);
      const verified = await this.secondVerify(decision, identity);
      if (!verified || verified.status !== true) {
        const error = new Error(verified && verified.message || '二次验证未完成');
        error.code = 'QISHUI_MFA_CANCELLED';
        throw error;
      }
      envelope = await this.request(
        'POST',
        '/passport/web/check_qrconnect/',
        { isResend: 'true' },
        { ...body, ...bizParams },
      );
      data = envelope.data || {};
      if (Number(data.error_code) === 2046) {
        throw new Error('二次验证已通过，但服务端仍返回 2046；请重新刷新二维码');
      }
    }
    if (Number(data.error_code) === 0 && (String(data.status) === '3' || String(data.status) === 'confirmed' || data.session_cookie)) {
      // 不再拿二维码代次做门槛：用户确认的那一刻就是有效凭据，
      // 中途刷新过二维码也照样要落盘，否则会「手机已确认、电脑仍显示未登录」。
      let saved;
      try {
        saved = await this.persistSessionCookies(data.session_cookie || '', envelope);
      } catch (error) {
        // 写凭据失败不能反过来把「已确认」这件事打成失败，
        // 否则前端又会继续轮询一个已被消费的 token，回到「二维码失效」。
        console.warn('[QishuiAuth] 凭据落盘异常:', error && error.message || error);
        saved = { ready: false, cookie: '', debug: { error: String(error && error.message || error) } };
      }
      if (!saved.ready) {
        // 有些版本的官方流程是在 check_qrconnect 之后，才由另一条 passport
        // 请求把 sessionid 种下来。给原生响应头钩子一点时间再收两次，
        // 否则会出现「手机确认了，本机却说没拿到凭据」。
        for (const delay of [350, 700]) {
          await new Promise(resolve => setTimeout(resolve, delay));
          try {
            const again = await this.persistSessionCookies('', envelope, true);
            if (again.ready) { saved = again; break; }
            saved = again;
          } catch { /* 保留上一次的诊断 */ }
        }
      }
      envelope.data = {
        ...data,
        cookieReady: saved.ready,
        cookie: saved.cookie,
        __cookieDebug: saved.debug,
      };
    }
    return envelope;
  }

  async persistSessionCookies(sessionCookie, envelope, quiet = false) {
    const current = {};
    const headerNames = [...this.capturedCookieJar.keys()];
    for (const [name, value] of this.capturedCookieJar) current[name] = value;

    // Electron cookie jar 再兜一层（同域请求种下的 cookie 仍会在这里）
    const jarNames = [];
    try {
      const cookies = await this.authSession.cookies.get({});
      for (const cookie of cookies) {
        const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
        const name = String(cookie.name || '');
        if (domain === 'qishui.com' || domain.endsWith('.qishui.com') || LOGIN_COOKIE_RE.test(name)) {
          current[name] = cookie.value;
          jarNames.push(name);
        }
      }
    } catch (error) {
      console.warn('[QishuiAuth] 读取会话 cookie 失败:', error && error.message || error);
    }

    // 响应体：官方字段 session_cookie，或任意层级里 cookie 形态的字符串
    const bodyNames = Object.keys(parseCookieString(sessionCookie));
    Object.assign(current, parseCookieString(sessionCookie));
    const bodyLike = [];
    collectCookieLikeStrings(envelope, bodyLike);
    for (const raw of bodyLike) Object.assign(current, parseCookieString(raw));

    const names = Object.keys(current);
    const loginNames = names.filter(name => LOGIN_COOKIE_RE.test(name));
    const debug = {
      headerNames,
      jarNames,
      bodyNames,
      collectedNames: names,
      loginNames,
      lastCapture: this.lastCookieCapture,
      responseHeaderNames: String(envelope && envelope.__responseHeaders || '')
        .split(/\r?\n/).map(line => line.split(':')[0].trim()).filter(Boolean).slice(0, 30),
    };
    if (this.destroying) return { ready: false, cookie: '', debug };

    const cookieString = buildCookieString(current);
    if (!cookieString || !loginNames.length) {
      // 没拿到登录票据就不要写，避免把一份「看着像 cookie、其实没登录」的串
      // 覆盖进配置文件，之后状态接口一直显示未登录却查不出原因。
      if (!quiet) console.warn('[QishuiAuth] 确认成功但未取得登录票据:', JSON.stringify(debug));
      return { ready: false, cookie: '', debug };
    }
    updateConfig({ cookie: cookieString, msToken: this.msToken });
    return { ready: true, cookie: cookieString, debug };
  }

  async clear() {
    this.qrGeneration += 1;
    this.capturedCookieJar.clear();
    this.lastCookieCapture = null;
    if (this.authSession) {
      await this.authSession.clearStorageData({
        storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage', 'serviceworkers'],
      });
      try { await this.authSession.flushStorageData(); } catch (_) {}
    }
    this.destroying = true;
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
    this.browserInfo = null;
    this.msToken = '';
    if (this.assetServer) await new Promise(resolve => this.assetServer.close(resolve));
    this.assetServer = null;
    this.assetBase = '';
    this.assetToken = crypto.randomBytes(18).toString('hex');
    this.destroying = false;
  }
}

async function initSignEngine() {
  if (!runtime) runtime = new QishuiAuthRuntime();
  return runtime.initialize();
}

async function getQrCode() {
  await initSignEngine();
  return runtime.getQrCode();
}

async function checkQrConnect(token) {
  await initSignEngine();
  return runtime.checkQrConnect(token);
}

// 只回传字段名，用于排查「确认了但没凭据」，不含任何票据值
function getCookieDiagnostics() {
  return {
    capturedNames: runtime ? [...runtime.capturedCookieJar.keys()] : [],
    lastCapture: runtime ? runtime.lastCookieCapture : null,
  };
}

async function clear() {
  if (runtime) {
    await runtime.clear();
  } else {
    if (!app.isReady()) await app.whenReady();
    const authSession = session.fromPartition(AUTH_PARTITION);
    await authSession.clearStorageData({
      storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage', 'serviceworkers'],
    });
    try { await authSession.flushStorageData(); } catch (_) {}
  }
  runtime = null;
}

module.exports = {
  configure,
  initSignEngine,
  getQrCode,
  checkQrConnect,
  clear,
  getCookieDiagnostics,
  constants: { API_BASE, AID, APP_VERSION, AUTH_PARTITION },
  // 供离线用例验证 Set-Cookie 截获与凭据合并，不参与运行时流程
  _test: { parseSetCookieValues, collectCookieLikeStrings, createRuntime: () => new QishuiAuthRuntime() },
};
