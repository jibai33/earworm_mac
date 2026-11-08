// ====================================================================
//  小宇宙播客客户端（闻曲 Earworm）
//  - 登录: 手机号 + 短信验证码（官网 Web API: send-code / login-with-sms），
//    换到 x-jike-access-token 后持久化；发码的人机验证票据绑在官网域名，
//    因此提供官方入口，验证码回填后的换 token 与存储完全本地完成。
//    另保留「手动粘贴 token」作为兜底。
//  - 搜索: /v1/search（播客 + 单集）
//  - 订阅: /v1/subscription（登录用户播客列表）
//  - 单集: /v1/podcast/get（播客详情+单集列表）、/v1/episode/get（单集详情+音频）
//  参考: ultrazg/xyz、MosesHe/xiaoyuzhoufm-mcp（MIT）
// ====================================================================
const https = require('https');
const crypto = require('crypto');

const XY_API = 'api.xiaoyuzhoufm.com';
const DEVICE_ID = crypto.createHash('md5').update('earworm-xy').digest('hex');
const XY_HEADERS = {
  'Host': XY_API,
  'User-Agent': 'Xiaoyuzhou/1.24.0 (app.podcast.cosmos; build:1576; iOS 16.0.0) Alamofire/4.9.1',
  'App-BuildNo': '1576',
  'OS': 'ios',
  'Manufacturer': 'Apple',
  'BundleID': 'app.podcast.cosmos',
  'abtest-info': '{"old_user_discovery_feed":"enable"}',
  'Accept-Language': 'zh-Hans-CN;q=1.0',
  'X-XY-Unique-ID': DEVICE_ID,
  'X-XY-App-Version': '1.24.0',
  'X-XY-Platform': 'ios',
};

/* ---------- token 持久化（由 server.js 注入存取器） ---------- */
let tokenStore = { get: () => ({}), save: () => {}, clear: () => {} };
function setTokenStore(s) { tokenStore = s; }
function xyToken() { return tokenStore.get(); } // { access, refresh, uid, nickname }
function setXyToken(t) { tokenStore.save(t); }
function xyLoggedIn() { return !!(xyToken().access); }

/* ---------- 请求 ---------- */
function xyPost(path, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const headers = Object.assign({
      'Content-Type': 'application/json;charset=UTF-8',
      'Content-Length': Buffer.byteLength(data),
    }, XY_HEADERS, extraHeaders || {});
    const t = xyToken();
    if (t.access && !headers['x-jike-access-token']) headers['x-jike-access-token'] = t.access;
    const req = https.request({ host: XY_API, path, method: 'POST', headers, timeout: 12000 }, (res) => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        let body = {};
        try { body = JSON.parse(buf || '{}'); } catch { body = { _html: true, code: res.statusCode === 401 ? 401 : 0 }; }
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.on('timeout', () => req.destroy(new Error('小宇宙请求超时')));
    req.on('error', reject);
    req.end(data);
  });
}

/* ---------- 登录：官网 Web API 的手机号 + 短信验证码 ---------- */
// 官网 www.xiaoyuzhoufm.com 用的是独立 Web API（与 App API 不是一条链路）：
//   POST /v1/auth/send-code       发验证码（官网强制人机验证 captcha.verifyParam）
//   POST /v1/auth/login-with-sms  验证码换 token（不需要 captcha）
// 网关要求 x-midway-app-id；登录成功后 token 以 set-cookie 下发，解析后存本地凭据。
// 人机验证票据只在官方域名生成，本地服务无法伪造，因此发码那一步提供官方入口；
// 换 token 与本地持久化完全由本服务完成。
const XY_WEB_API = 'web-api.xiaoyuzhoufm.com';
const XY_MIDWAY_APP_ID = 'v6worU4NnWyL';
const XY_OFFICIAL_URL = 'https://www.xiaoyuzhoufm.com/';
const XY_LOGIN_HINT = '小宇宙登录已失效，请在「我的 → 登录」用手机号 + 短信验证码重新登录';

function xyWebPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const headers = {
      'Content-Type': 'application/json;charset=UTF-8',
      'Content-Length': Buffer.byteLength(data),
      'Host': XY_WEB_API,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
      'Origin': 'https://www.xiaoyuzhoufm.com',
      'Referer': XY_OFFICIAL_URL,
      'Accept': 'application/json',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'App-Version': '5.7.0',
      'x-midway-app-id': XY_MIDWAY_APP_ID,
    };
    const t = xyToken();
    if (t.access) headers['x-jike-access-token'] = t.access;
    const req = https.request({ host: XY_WEB_API, path, method: 'POST', headers, timeout: 15000 }, (res) => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        let out = {};
        try { out = JSON.parse(buf || '{}'); } catch { out = { _raw: buf.slice(0, 300) }; }
        resolve({ status: res.statusCode, headers: res.headers, body: out });
      });
    });
    req.on('timeout', () => req.destroy(new Error('小宇宙官网请求超时')));
    req.on('error', reject);
    req.end(data);
  });
}

function xyCookieToken(headers, name) {
  for (const line of headers['set-cookie'] || []) {
    const m = String(line).match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)', 'i'));
    if (m) { try { return decodeURIComponent(m[1]); } catch { return m[1]; } }
  }
  const direct = headers[name];
  return Array.isArray(direct) ? direct[0] : (direct || '');
}

function normalizePhone(input) {
  let area = String(input.areaCode || '+86').trim();
  if (!area.startsWith('+')) area = '+' + area.replace(/\D/g, '');
  const phone = String(input.mobilePhoneNumber || '').replace(/[\s\-()]/g, '');
  if (!/^\+\d{1,4}$/.test(area)) throw new Error('区号格式不对，请填 +86 这样的格式');
  if (!/^\d{6,15}$/.test(phone)) throw new Error('手机号格式不对，请只填数字');
  return { areaCode: area, mobilePhoneNumber: phone };
}

/* 第 1 步：发送验证码。captchaVerifyParam 由官方页的人机验证产生，缺失时明确返回去官网的引导 */
async function handleXYSendCode(input) {
  const opt = input || {};
  const p = normalizePhone(opt);
  const vp = String(opt.captchaVerifyParam || '').trim();
  const body = Object.assign({}, p);
  if (vp) body.captcha = { scene: 'web', verifyParam: vp };
  let r;
  try { r = await xyWebPost('/v1/auth/send-code', body); }
  catch (e) { return { ok: false, message: '连接小宇宙官网失败：' + e.message }; }
  const msg = r.body.message || r.body.toast || '';
  if (r.status >= 400) {
    if (/body\/captcha|captcha/i.test(msg)) {
      return {
        ok: false, needCaptcha: true, officialUrl: XY_OFFICIAL_URL,
        message: '官网发码前要求人机验证。请点「去官网获取验证码」完成验证并接收短信，回来填入验证码即可。',
      };
    }
    if (vp && /invalid params/i.test(msg)) return { ok: false, captchaInvalid: true, message: '人机验证票据已失效，请重新去官网获取验证码' };
    return { ok: false, message: msg || ('发送失败（HTTP ' + r.status + '）') };
  }
  return { ok: true, message: '验证码已发送，请查看短信' };
}

/* 第 2 步：验证码换 token → 解析 set-cookie → 存本地凭据文件 */
async function handleXYLoginSMS(input) {
  const opt = input || {};
  const p = normalizePhone(opt);
  const code = String(opt.verifyCode || '').replace(/\D/g, '');
  if (!/^\d{4,8}$/.test(code)) throw new Error('请输入收到的短信验证码（纯数字）');
  let r;
  try { r = await xyWebPost('/v1/auth/login-with-sms', Object.assign({}, p, { verifyCode: code })); }
  catch (e) { throw new Error('连接小宇宙官网失败：' + e.message); }
  const msg = r.body.message || r.body.toast || '';
  if (r.status >= 400) {
    if (/invalid params|verify|code|过期/i.test(msg)) throw new Error('验证码不正确或已过期，请重新获取');
    throw new Error(msg || ('登录失败（HTTP ' + r.status + '）'));
  }
  const d = r.body.data || {};
  const access = xyCookieToken(r.headers, 'x-jike-access-token') || d.accessToken || d.token || '';
  const refresh = xyCookieToken(r.headers, 'x-jike-refresh-token') || d.refreshToken || '';
  if (!access) {
    return {
      ok: false, needManualToken: true, officialUrl: XY_OFFICIAL_URL,
      message: '官网已通过验证，但没返回可直接读取的 token。请改用下方「手动粘贴」，或直接在官网登录后复制 x-jike-access-token。',
    };
  }
  const u = d.user || d;
  const avatar = (u.avatar && (u.avatar.smallPicUrl || u.avatar.middlePicUrl || u.avatar.picture)) || '';
  setXyToken({
    access, refresh, uid: u.uid || '', nickname: u.nickname || '',
    avatar, at: Date.now(), via: 'sms', phone: p.mobilePhoneNumber.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2'),
  });
  return { ok: true, loggedIn: true, via: 'sms', nickname: u.nickname || '', at: Date.now() };
}

// 容错：整段请求头 / curl 片段 / JSON / 引号包裹 / 换行，都能抽出 token
function normalizeXyToken(input) {
  let s = String(input || '').trim();
  const header = s.match(/x-jike-access-token\s*[:=]\s*["']?([A-Za-z0-9._-]+)/i);
  if (header) s = header[1];
  else {
    const jwt = s.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    if (jwt) s = jwt[0];
  }
  return s.replace(/^["'`\s,;]+|["'`\s,;]+$/g, '').replace(/\s+/g, '');
}
async function handleXYSetToken(input) {
  const t = normalizeXyToken(input);
  if (!t || /[^A-Za-z0-9\-_.]/.test(t)) {
    throw new Error('没识别出 token，请粘贴 x-jike-access-token 的值（整段请求头也可以）');
  }
  setXyToken({ access: t, refresh: '', uid: '', nickname: '', avatar: '', at: Date.now() });
  // 用订阅接口验证 token 有效性
  let r;
  try { r = await xyPost('/v1/subscription', { loadMoreKey: { limit: 5 } }); }
  catch (e) { tokenStore.clear(); throw new Error('验证失败：' + e.message); }
  if (r.status === 401 || r.body.code === 401) {
    tokenStore.clear();
    throw new Error('token 无效或已过期，请用手机号 + 验证码重新登录，或在官网重新复制');
  }
  return { ok: true, loggedIn: true, via: 'manual', officialUrl: XY_OFFICIAL_URL, hint: 'token 有时效，过期后用短信验证码重新登录即可' };
}
async function handleXYLogout() { tokenStore.clear(); return { ok: true }; }
function handleXYStatus() {
  const t = xyToken();
  return {
    provider: 'xy', loggedIn: !!t.access,
    nickname: t.nickname || '', avatar: t.avatar || '', uid: t.uid || '',
    at: t.at || 0, via: t.via || 'manual', phone: t.phone || '',
    officialUrl: XY_OFFICIAL_URL, hint: XY_LOGIN_HINT,
  };
}

/* ---------- 映射 ---------- */
function mapXYPodcast(p) {
  p = p || {};
  const img = p.image ? (p.image.smallPicUrl || p.image.middlePicUrl || p.image.largePicUrl || '') : '';
  return {
    provider: 'xy', source: 'xy', type: 'podcast',
    id: p.pid || '', pid: p.pid || '',
    name: p.title || '', nameCN: '',
    artist: p.author || '', host: p.author || '',
    album: '', cover: img, image: img,
    duration: 0, episodesCount: p.episodesCount || 0,
    description: p.description || '',
    fee: 0, isPodcast: true,
  };
}
function mapXYEpisode(e) {
  e = e || {};
  const pc = e.podcast || {};
  const img = (e.image && e.image.smallPicUrl) || (pc.image && (pc.image.smallPicUrl || pc.image.middlePicUrl)) || '';
  return {
    provider: 'xy', source: 'xy', type: 'episode',
    id: e.eid || '', epid: e.eid || '',
    pid: e.pid || pc.pid || '',
    name: e.title || '',
    artist: pc.author || pc.title || '播客',
    album: pc.title || '',
    cover: img, image: img,
    duration: (e.duration || 0) * 1000,
    pubDate: e.pubDate || 0,
    shownotes: e.shownotes || '',
    hasShownotes: !!e.hasShownotes,
    fee: 0, isEpisode: true,
  };
}

/* ---------- 搜索 ---------- */
async function handleXYSearch(keyword, limit, offset) {
  const loadMoreKey = offset > 0 ? { nextOffset: offset } : { limit: 20 };
  const r = await xyPost('/v1/search', { type: 'ALL', keyword: String(keyword || ''), loadMoreKey });
  if (r.status === 401 || r.body.code === 401) return { provider: 'xy', error: 'NEED_LOGIN', message: XY_LOGIN_HINT, songs: [], hasMore: false };
  const d = r.body.data || {};
  const podcasts = (d.podcasts || []).map(mapXYPodcast);
  const episodes = (d.episodes || []).map(mapXYEpisode);
  // 播客在前、单集在后；每类 20 条一页
  const total = podcasts.length + episodes.length;
  return { provider: 'xy', songs: [...podcasts, ...episodes], hasMore: total >= 20 };
}

/* ---------- 播客详情 + 单集列表 ---------- */
async function handleXYPodcast(pid, loadMoreKey) {
  const r = await xyPost('/v1/podcast/get', { pid, loadMoreKey: loadMoreKey || undefined });
  if (r.status === 401 || r.body.code === 401) return { provider: 'xy', error: 'NEED_LOGIN', message: XY_LOGIN_HINT, episodes: [] };
  const d = r.body.data || {};
  return {
    provider: 'xy', podcast: mapXYPodcast(d),
    episodes: (d.episodes || []).map(mapXYEpisode),
    loadMoreKey: d.loadMoreKey || null,
    total: d.episodesCount || 0,
  };
}

/* ---------- 单集详情（含音频地址） ---------- */
async function handleXYEpisode(eid) {
  const r = await xyPost('/v1/episode/get', { eid });
  if (r.status === 401 || r.body.code === 401) return { provider: 'xy', error: 'NEED_LOGIN', message: XY_LOGIN_HINT, episode: {}, enclosure: null };
  const d = r.body.data || {};
  return { provider: 'xy', episode: mapXYEpisode(d), enclosure: d.enclosure || null };
}

/* ---------- 订阅列表（登录后） ---------- */
async function handleXYSubscription(limit) {
  if (!xyLoggedIn()) return { provider: 'xy', loggedIn: false, podcasts: [] };
  const r = await xyPost('/v1/subscription', { loadMoreKey: { limit: limit || 100 } });
  if (r.status === 401 || r.body.code === 401) {
    // /v1/auth/refreshToken 实测 404（另试四种常见路径也全 404），自动续期不可行。
    //  因此这里直接给可读的过期提示，由前端引导用户重新取 token。
    return { provider: 'xy', loggedIn: false, podcasts: [], expired: true, message: XY_LOGIN_HINT };
  }
  const d = r.body.data || {};
  return { provider: 'xy', loggedIn: true, podcasts: (d.subscriptions || []).map(mapXYPodcast) };
}

module.exports = {
  setTokenStore, xyToken, xyLoggedIn, normalizeXyToken,
  handleXYSendCode, handleXYLoginSMS, handleXYSetToken, handleXYLogout, handleXYStatus,
  handleXYSearch, handleXYPodcast, handleXYEpisode, handleXYSubscription,
};
