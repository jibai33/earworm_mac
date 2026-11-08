/* ====================================================================
 * 闻曲 · 听感画像客户端（平台无关）
 * 浏览器、WKWebView(macOS)、WKWebView(iOS) 都可直接加载：
 *   - 只依赖 fetch / localStorage，无框架、无平台 SDK
 *   - 与服务端 /api/taste/* 的契约见 README「跨端画像契约」
 *   - 同一服务地址 + 同一同步码 = 同一份画像
 * ==================================================================== */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.Taste = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const LS = {
    key: 'ew_sync_key',
    device: 'ew_device_id',
    queue: 'ew_taste_queue',
    enabled: 'ew_taste_enabled',
    synced: 'ew_taste_synced',
  };
  const FLUSH_EVERY = 5000;
  const BATCH_SIZE = 20;
  const MAX_QUEUE = 400;

  /* ---------- 存储兜底：原生 WebView 可能禁用 localStorage ---------- */
  const mem = {};
  function get(k) {
    try { const v = root.localStorage && root.localStorage.getItem(k); return v == null ? (mem[k] || '') : v; }
    catch { return mem[k] || ''; }
  }
  function set(k, v) {
    mem[k] = String(v);
    try { if (root.localStorage) root.localStorage.setItem(k, String(v)); } catch { /* 内存兜底 */ }
  }
  function getJSON(k, fallback) {
    try { return JSON.parse(get(k) || 'null') || fallback; } catch { return fallback; }
  }
  function setJSON(k, v) { set(k, JSON.stringify(v)); }

  function uuid() {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') return root.crypto.randomUUID();
    if (root.crypto && root.crypto.getRandomValues) {
      const b = root.crypto.getRandomValues(new Uint8Array(8));
      return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    }
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }

  const cfg = {
    urlFn: null,
    base: '',
    syncKey: '',
    deviceId: '',
    platform: 'web',
    enabled: true,
    onSync: null,
    onError: null,
  };
  let timer = null, flushing = false, retryDelay = 5000, lastAttempt = 0;

  function detectPlatform() {
    try {
      const ua = (root.navigator && root.navigator.userAgent) || '';
      if (/iPhone|iPad|iPod/.test(ua)) return 'ios-pwa';
      if (/Android/.test(ua)) return 'android-pwa';
    } catch { /* ignore */ }
    return 'web';
  }

  /** 生成 URL。web 端传入 app.js 的 apiUrl 以复用自定义服务地址与 sharecode。 */
  function url(path, extra) {
    let u = cfg.urlFn ? cfg.urlFn(path) : cfg.base + path;
    const sep = u.includes('?') ? '&' : '?';
    const parts = [];
    if (cfg.syncKey) parts.push('syncKey=' + encodeURIComponent(cfg.syncKey));
    if (extra) for (const [k, v] of Object.entries(extra)) {
      if (v != null && v !== '') parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    }
    return u + (parts.length ? sep + parts.join('&') : '');
  }

  async function request(path, { method = 'GET', body, extra, timeout = 9000 } = {}) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const tid = ctl ? setTimeout(() => ctl.abort(), timeout) : null;
    try {
      const opts = { method, signal: ctl ? ctl.signal : undefined };
      if (body !== undefined) {
        opts.headers = { 'Content-Type': 'application/json' };
        opts.body = JSON.stringify(body);
      }
      const r = await fetch(url(path, extra), opts);
      const data = await r.json();
      if (!r.ok && r.status >= 500) throw new Error(data.error || ('HTTP ' + r.status));
      return data;
    } finally { if (tid) clearTimeout(tid); }
  }

  function payload() {
    return { syncKey: cfg.syncKey, deviceId: cfg.deviceId, platform: cfg.platform };
  }

  /* ---------- 采集 ---------- */
  function track(type, data) {
    if (!cfg.enabled) return;
    const d = data || {};
    const ev = {
      id: uuid(),
      type,
      ts: Date.now(),
      song: d.song || {},
      meta: d.meta || {},
    };
    const q = getJSON(LS.queue, []);
    q.push(ev);
    if (q.length > MAX_QUEUE) q.splice(0, q.length - MAX_QUEUE);
    setJSON(LS.queue, q);
    if (q.length >= BATCH_SIZE) flush();
  }

  async function flush(force) {
    if (flushing) return { ok: false, reason: 'busy' };
    const q = getJSON(LS.queue, []);
    if (!q.length) return { ok: true, sent: 0 };
    if (!force && Date.now() - lastAttempt < retryDelay) return { ok: false, reason: 'backoff' };
    lastAttempt = Date.now();
    flushing = true;
    try {
      const r = await request('/api/taste/events', {
        method: 'POST',
        body: Object.assign(payload(), { events: q.slice(0, BATCH_SIZE) }),
      });
      const rest = getJSON(LS.queue, []).slice(q.length);
      setJSON(LS.queue, rest);
      retryDelay = 5000;
      set(LS.synced, String(Date.now()));
      if (cfg.onSync) cfg.onSync(r);
      if (rest.length) setTimeout(() => flush(true), 100);
      return r;
    } catch (e) {
      retryDelay = Math.min(60000, retryDelay * 2);
      if (cfg.onError) cfg.onError(e);
      return { ok: false, error: e.message };
    } finally { flushing = false; }
  }

  /* ---------- 画像 / 推荐 ---------- */
  async function bootstrap() {
    const r = await request('/api/taste/bootstrap', {
      method: 'POST',
      body: Object.assign(payload(), {}),
      timeout: 30000,
    });
    if (r && r.syncKey) {
      cfg.syncKey = r.syncKey;
      set(LS.key, r.syncKey);
      // 启动时把离线队列补报一次
      if (getJSON(LS.queue, []).length) flush(true);
    }
    if (r && r.profile && r.profile.settings && typeof r.profile.settings.enabled === 'boolean') {
      cfg.enabled = r.profile.settings.enabled;
      set(LS.enabled, cfg.enabled ? '1' : '0');
    }
    return r;
  }
  const recommend = (variant) => request('/api/taste/recommend', { extra: { variant: variant || 0 }, timeout: 30000 });
  const profile = () => request('/api/taste/profile');
  const events = (since, limit) => request('/api/taste/events', { extra: { since, limit } });
  const exportData = () => request('/api/taste/export');

  async function settings(patch) {
    if (typeof patch.enabled === 'boolean') {
      cfg.enabled = patch.enabled;
      set(LS.enabled, patch.enabled ? '1' : '0');
      if (!patch.enabled) setJSON(LS.queue, []); // 关闭时丢弃未上报队列
    }
    const r = await request('/api/taste/settings', {
      method: 'POST', body: Object.assign(payload(), { settings: patch }),
    });
    if (cfg.enabled && getJSON(LS.queue, []).length) flush(true);
    return r;
  }
  function feedback(kind, value, action) {
    return request('/api/taste/feedback', {
      method: 'POST', body: Object.assign(payload(), { kind, value, action: action || 'dislike' }),
    });
  }
  async function clear() {
    setJSON(LS.queue, []);
    return request('/api/taste/clear', { method: 'POST', body: Object.assign(payload(), { keepSettings: true }) });
  }
  async function bindSyncKey(targetKey) {
    const r = await request('/api/taste/sync-key', {
      method: 'POST', body: Object.assign(payload(), { mode: 'bind', targetKey }),
    });
    if (r && r.syncKey) { cfg.syncKey = r.syncKey; set(LS.key, r.syncKey); }
    return r;
  }
  async function createSyncKey() {
    const r = await request('/api/taste/sync-key', {
      method: 'POST', body: Object.assign(payload(), { mode: 'create' }),
    });
    if (r && r.syncKey) { cfg.syncKey = r.syncKey; set(LS.key, r.syncKey); }
    return r;
  }

  /* ---------- 初始化 ---------- */
  function init(opts) {
    const o = opts || {};
    if (typeof o.urlFn === 'function') cfg.urlFn = o.urlFn;
    if (typeof o.base === 'string') cfg.base = o.base.replace(/\/$/, '');
    if (o.platform) cfg.platform = o.platform;
    else cfg.platform = detectPlatform();
    cfg.syncKey = o.syncKey || get(LS.key) || '';
    cfg.deviceId = o.deviceId || get(LS.device) || '';
    if (!cfg.deviceId) { cfg.deviceId = uuid(); set(LS.device, cfg.deviceId); }
    cfg.enabled = get(LS.enabled) !== '0';
    if (o.onSync) cfg.onSync = o.onSync;
    if (o.onError) cfg.onError = o.onError;

    if (timer) clearInterval(timer);
    timer = setInterval(() => { if (cfg.enabled) flush(); }, FLUSH_EVERY);
    try {
      root.addEventListener('pagehide', () => { if (cfg.enabled) flush(true); });
      root.addEventListener('visibilitychange', () => {
        if (root.document && root.document.visibilityState === 'hidden' && cfg.enabled) flush(true);
      });
    } catch { /* 非浏览器环境 */ }
    return api;
  }

  const api = {
    init, track, flush, bootstrap, recommend, profile, events, exportData,
    settings, feedback, clear, bindSyncKey, createSyncKey,
    getSyncKey: () => cfg.syncKey,
    setSyncKey: (k) => { cfg.syncKey = String(k || '').toUpperCase(); set(LS.key, cfg.syncKey); },
    getDeviceId: () => cfg.deviceId,
    getPlatform: () => cfg.platform,
    isEnabled: () => cfg.enabled,
    queueSize: () => getJSON(LS.queue, []).length,
    lastSynced: () => Number(get(LS.synced) || 0),
    _url: url,
  };
  return api;
});
