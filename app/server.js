// ====================================================================
//  闻曲 Earworm — 独立服务端
//  仅为 Web/PWA 前端提供网易云接口与静态资源
//  运行: node server.js  (PORT 环境变量可改端口, 默认 3210)
// ====================================================================
const {
  cloudsearch,
  song_url_v1,
  lyric_new,
  lyric,
  login_qr_key,
  login_qr_create,
  login_qr_check,
  login_status,
  user_account,
  user_playlist,
  playlist_track_all,
  playlist_detail,
  song_like,
  song_like_check,
  recommend_songs,
  personalized,
  personalized_newsong,
  like: like_song,
  likelist,
  comment_music,
} = require('NeteaseCloudMusicApi');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ---------- 多平台模块 ---------- */
const qishuiApi = require('./modules/qishui-api.js');
const qqApi = require('./modules/qq-api.js');
const qqQrLogin = require('./modules/qq-qr-login.js');
const xyApi = require('./modules/xiaoyuzhou-api.js');
const qishuiQrLogin = require('./modules/qishui-qr-login.js');
const loginEgg = require('./modules/login-egg.js');
const electronRuntime = require('./modules/electron-runtime');
const QISHUI_QR_AVAILABLE = electronRuntime.isChromiumShim ? !!electronRuntime.findChrome() : true;
const tasteProfile = require('./modules/taste-profile.js');
const recommender = require('./modules/recommend.js');
const night = require('./modules/night.js');
const crate = require('./modules/crate.js');
const wall = require('./modules/wall.js');
const yearbook = require('./modules/yearbook.js');
const replay = require('./modules/replay.js');
const { timeOf } = require('./modules/event-time.js');
const { createUnified } = require('./modules/unified.js');
const { TrackDecryptor } = require('./modules/qishui-audio-decryptor/track-decryptor');
const qishuiAudioDecryptor = new TrackDecryptor();
// 凭据 / 画像的落盘位置：桌面版指向 Application Support，Web 版退回工程目录
const userPaths = require('./user-paths');

const QISHUI_COOKIE_FILE = userPaths.dataFile('.qishui-cookie');
const QQ_COOKIE_FILE = userPaths.dataFile('.qq-cookie');
let qishuiCookie = '';
try { qishuiCookie = fs.readFileSync(QISHUI_COOKIE_FILE, 'utf8').trim(); } catch { /* 首次无 cookie */ }
try { qqApi.setQQCookie(fs.readFileSync(QQ_COOKIE_FILE, 'utf8').trim()); } catch { /* 首次无 cookie */ }
function saveQishuiCookie(c) {
  qishuiCookie = String(c || '').trim();
  try { fs.writeFileSync(QISHUI_COOKIE_FILE, qishuiCookie); } catch (e) { console.error('[QishuiCookie] 写入失败', e.message); }
}
// 扫码登录把票据写在 .qishui-qr-login.json 里。旧版本（或确认那次进程被退出）
// 可能没同步到 .qishui-cookie，重启后就又显示未登录 —— 启动时补一次。
try {
  if (!qishuiCookie) {
    const qrConfig = JSON.parse(fs.readFileSync(userPaths.dataFile('.qishui-qr-login.json'), 'utf8'));
    const saved = String(qrConfig.cookie || '').trim();
    if (/(?:^|;\s*)(?:sessionid|sessionid_ss|sid_guard|sid_tt|uid_tt|uid_tt_ss)=/i.test(saved)) {
      qishuiCookie = saved;
      fs.writeFileSync(QISHUI_COOKIE_FILE, qishuiCookie);
      console.log('[QishuiCookie] 已从扫码配置回填登录凭据');
    }
  }
} catch { /* 首次运行，没有扫码配置 */ }
function saveQQCookie(c) {
  qqApi.setQQCookie(String(c || '').trim());
  try { fs.writeFileSync(QQ_COOKIE_FILE, qqApi.getQQCookie()); } catch (e) { console.error('[QQCookie] 写入失败', e.message); }
}

/* 小宇宙 token（JSON: access/refresh/uid/nickname） */
const XY_TOKEN_FILE = userPaths.dataFile('.xy-token.json');
let xyTokenData = {};
try { xyTokenData = JSON.parse(fs.readFileSync(XY_TOKEN_FILE, 'utf8')); } catch { /* 首次无 token */ }
xyApi.setTokenStore({
  get: () => xyTokenData,
  save: (t) => {
    xyTokenData = t || {};
    try { fs.writeFileSync(XY_TOKEN_FILE, JSON.stringify(xyTokenData, null, 1)); } catch (e) { console.error('[XYToken] 写入失败', e.message); }
  },
  clear: () => { xyTokenData = {}; try { fs.unlinkSync(XY_TOKEN_FILE); } catch { /* 无文件 */ } },
});

const PORT = Number(process.env.PORT || 3210);
const HOST = process.env.HOST || '0.0.0.0';
const COOKIE_FILE = userPaths.dataFile('.cookie');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/* ---------- cookie 持久化 ---------- */
let userCookie = '';
try { userCookie = fs.readFileSync(COOKIE_FILE, 'utf8').trim(); } catch { /* 首次无 cookie */ }
function saveCookie(c) {
  userCookie = String(c || '').trim();
  try { fs.writeFileSync(COOKIE_FILE, userCookie); } catch (e) { console.error('[Cookie] 写入失败', e.message); }
}

/* ---------- 工具 ---------- */
function sendJSON(res, obj, code) {
  const body = JSON.stringify(obj);
  res.writeHead(code || 200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}
function mapArtists(list) {
  return (list || []).map(a => ({ id: a && a.id, name: a && a.name }));
}
function mapSongRecord(s) {
  s = s || {};
  const artists = mapArtists(s.ar || s.artists);
  const album = s.al || s.album || {};
  return {
    provider: 'netease', source: 'netease', type: 'song',
    id: s.id, name: s.name,
    artist: artists.map(a => a.name).join(' / '),
    artists,
    artistId: artists[0] && artists[0].id,
    album: album.name || '',
    albumId: album.id || '',
    cover: album.picUrl || album.coverUrl || '',
    duration: s.dt || s.duration || 0,
    fee: s.fee,
  };
}
function mapPlaylist(p) {
  p = p || {};
  const creator = p.creator || {};
  return {
    provider: 'netease', source: 'netease', type: 'playlist',
    id: p.id, name: p.name,
    cover: p.coverImgUrl || p.picUrl || '',
    trackCount: p.trackCount || 0,
    playCount: p.playCount || 0,
    creator: creator.nickname || '',
    subscribed: !!p.subscribed,
    specialType: p.specialType || 0,
    tag: (p.tags && p.tags[0]) || '',
  };
}
function normalizeLoginInfo(profile, account, extra) {
  const vipType = Number((profile || {}).vipType || (extra || {}).vipType || 0);
  const labelMap = { 11: 'SVIP', 1: 'VIP' };
  return {
    loggedIn: !!(profile && profile.nickname),
    nickname: (profile && profile.nickname) || '',
    avatar: (profile && profile.avatarUrl) || '',
    vipType,
    vipLabel: labelMap[vipType] || '无VIP',
    userId: (account && account.id) || (profile && profile.userId) || 0,
  };
}
async function getLoginInfo() {
  try {
    const r = await login_status({ cookie: userCookie, timestamp: Date.now() });
    const b = r.body || {};
    const profile = b.profile || b.data && b.data.profile || {};
    const account = b.account || b.data && b.data.account || {};
    return normalizeLoginInfo(profile, account, b);
  } catch {
    return { loggedIn: false, nickname: '', avatar: '', vipType: 0, vipLabel: '无VIP', userId: 0 };
  }
}

/* ---------- 封面代理 ---------- */
function proxyCover(res, coverUrl) {
  const mod = coverUrl.startsWith('https') ? https : http;
  const req = mod.get(coverUrl, { headers: { 'User-Agent': UA, 'Referer': 'https://music.163.com/' } }, (up) => {
    if (res.headersSent || res.writableEnded) { up.resume(); return; }
    res.writeHead(200, { 'Content-Type': up.headers['content-type'] || 'image/jpeg', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=86400' });
    up.pipe(res);
  });
  // 上游失败时响应头可能已经发出去了，这时再 writeHead 会抛 ERR_HTTP_HEADERS_SENT，
  // 而它发生在异步回调里、不在路由的 try 内 —— 未捕获就会把整个服务进程打死。
  req.on('error', () => failSoft(res, 404));
  res.on('error', () => { try { req.destroy(); } catch { /* ignore */ } });
}

/* 响应已经开始了就只能断开，不能再改状态码 */
function failSoft(res, code) {
  if (res.headersSent || res.writableEnded) {
    try { res.destroy(); } catch { /* ignore */ }
    return;
  }
  try { res.writeHead(code); res.end(); } catch { /* ignore */ }
}

/* ---------- 音频代理 ---------- */
const QISHUI_AUDIO_CACHE_MAX_BYTES = 96 * 1024 * 1024;
const qishuiAudioCache = new Map();
let qishuiAudioCacheBytes = 0;
function qishuiAudioAuthFromUrl(audioUrl) {
  const idx = String(audioUrl).indexOf('#auth=');
  if (idx < 0) return null;
  const authRaw = audioUrl.slice(idx + 6);
  let auth = authRaw;
  try { auth = decodeURIComponent(authRaw); } catch { /* 原样 */ }
  return { cleanUrl: audioUrl.slice(0, idx), auth };
}
function getQishuiDecryptedAudio(cleanUrl, auth) {
  const key = crypto.createHash('sha1').update(cleanUrl + '\n' + auth).digest('hex');
  const cached = qishuiAudioCache.get(key);
  if (cached) { cached.at = Date.now(); return Promise.resolve(cached); }
  return fetch(cleanUrl).then(async (up) => {
    if (!up.ok) throw new Error('汽水加密音频拉取失败: HTTP ' + up.status);
    const encryptedBuffer = Buffer.from(await up.arrayBuffer());
    const result = qishuiAudioDecryptor.decrypt({ encryptedBuffer, spadeA: auth });
    const payload = {
      buffer: result.buffer,
      contentType: result.extension === '.flac' ? 'audio/flac' : 'audio/mp4',
      at: Date.now(),
    };
    qishuiAudioCache.set(key, payload);
    qishuiAudioCacheBytes += payload.buffer.length;
    while (qishuiAudioCacheBytes > QISHUI_AUDIO_CACHE_MAX_BYTES && qishuiAudioCache.size > 1) {
      const oldest = [...qishuiAudioCache.entries()].sort((a, b) => (a[1].at || 0) - (b[1].at || 0))[0];
      if (!oldest) break;
      qishuiAudioCache.delete(oldest[0]);
      qishuiAudioCacheBytes -= oldest[1].buffer.length;
    }
    return payload;
  });
}
function sendAudioBuffer(res, buffer, contentType, range) {
  const total = buffer.length;
  const m = /^bytes=(\d*)-(\d*)$/i.exec(String(range || ''));
  if (m) {
    let start = m[1] ? Number(m[1]) : 0;
    let end = m[2] ? Number(m[2]) : total - 1;
    if (!Number.isFinite(start) || start < 0) start = 0;
    if (!Number.isFinite(end) || end >= total) end = total - 1;
    if (start > end || start >= total) { res.writeHead(416, { 'Content-Range': 'bytes */' + total }); return res.end(); }
    res.writeHead(206, { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${total}` });
    return res.end(buffer.subarray(start, end + 1));
  }
  res.writeHead(200, { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes', 'Content-Length': total });
  res.end(buffer);
}
function audioRefererFor(au) {
  try {
    const host = new URL(au).host;
    if (host.includes('qq.com') || host.includes('qpic.cn')) return 'https://y.qq.com/';
    if (host.includes('qishui.com') || host.includes('byteimg.com') || host.includes('douyin')) return 'https://www.qishui.com/';
    if (host.includes('music.163.com') || host.includes('163.com')) return 'https://music.163.com/';
  } catch { /* ignore */ }
  return '';
}
function proxyAudio(res, au, range) {
  const headers = { 'User-Agent': UA };
  const ref = audioRefererFor(au);
  if (ref) headers.Referer = ref;
  if (range) headers.Range = range;
  const mod = au.startsWith('https') ? https : http;
  const req2 = mod.get(au, { headers }, (up) => {
    if (res.headersSent || res.writableEnded) { up.resume(); return; }
    const wh = { 'Content-Type': up.headers['content-type'] || 'audio/mp4', 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes' };
    if (up.headers['content-range']) wh['Content-Range'] = up.headers['content-range'];
    if (up.headers['content-length']) wh['Content-Length'] = up.headers['content-length'];
    res.writeHead(up.statusCode, wh);
    up.pipe(res);
  });
  req2.on('error', () => failSoft(res, 502));
  res.on('error', () => { try { req2.destroy(); } catch { /* ignore */ } });
}

/* ---------- 请求体 ---------- */
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}

/* ---------- 听感画像：曲库检索回调 + 推荐缓存 ---------- */
async function tasteSearch(keyword, limit) {
  const r = await cloudsearch({ keywords: keyword, limit, offset: 0, cookie: userCookie });
  return ((r.body.result && r.body.result.songs) || []).map(mapSongRecord);
}
/* ---------- 统一音源层：一次连接，四平台音源与信息同屏 ---------- */
const unified = createUnified({
  getNeteaseCookie: () => userCookie,
  getQishuiCookie: () => qishuiCookie,
  getQQCookie: () => qqApi.getQQCookie(),
  getLoginOptions: () => ({
    netease: { qr: true, methods: ['网易云音乐 App 扫码'] },
    qq: {
      qr: true,
      methods: (qqQrLogin.getChannels() || []).filter(c => c.available !== false).map(c => c.label),
      note: '三条通道：手机 QQ / 微信 / QQ 音乐 App',
    },
    qishui: {
      qr: QISHUI_QR_AVAILABLE,
      methods: QISHUI_QR_AVAILABLE ? ['抖音 App 扫码'] : ['手动粘贴 cookie'],
      runtime: electronRuntime.isChromiumShim ? '本机 Chrome' : 'Electron',
      note: QISHUI_QR_AVAILABLE ? '' : '本机没有 Chrome / Electron，扫码通道不可用，请用手动凭据',
    },
    xy: { qr: false, methods: ['手机号 + 短信验证码'], note: '官网 Web 接口换取 token 并保存在本机' },
  }),
});

const tasteCache = new Map(); // syncKey -> { updatedAt, ts, data }
// 今日一曲：同一天、同一画像只检索一次曲库；「已听」每次仍按事件流实时算
const dailyCache = new Map(); // key:day -> { ts, song, reason, line }
async function tasteRecommendations(p, variant = 0) {
  const ck = p.key + ':' + variant;
  const hit = tasteCache.get(ck);
  if (hit && hit.updatedAt === p.updatedAt && Date.now() - hit.ts < 60000) return hit.data;
  const data = await recommender.buildRecommendations({ events: p.events, profile: p, searchFn: tasteSearch, variant });
  tasteCache.set(ck, { updatedAt: p.updatedAt, ts: Date.now(), data });
  return data;
}

/* ---------- 路由 ---------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pn = u.pathname;
  const q = u.searchParams;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  try {
    // ---------- 搜索 ----------
    if (pn === '/api/search') {
      const kw = q.get('keywords') || '';
      const limit = Math.min(50, parseInt(q.get('limit') || '20', 10) || 20);
      const offset = Math.max(0, parseInt(q.get('offset') || '0', 10) || 0);
      const r = await cloudsearch({ keywords: kw, limit, offset, cookie: userCookie });
      const songs = (r.body.result && r.body.result.songs || []).map(mapSongRecord);
      return sendJSON(res, { songs, offset, limit, hasMore: songs.length >= limit });
    }

    // ---------- 播放地址 ----------
    if (pn === '/api/song/url') {
      const id = q.get('id');
      const quality = q.get('quality') || '';
      const tryLevels = [quality || 'exhigh'];
      if (quality && quality !== 'standard') tryLevels.push('standard');
      let d = null, lastErr = null;
      for (const level of tryLevels) {
        try {
          const r = await song_url_v1({ id, level, cookie: userCookie, timestamp: Date.now() });
          d = (r.body.data || [])[0] || null;
          if (d && d.url) break;
        } catch (e) { lastErr = e; /* 降级重试 */ }
      }
      if (!d) {
        return sendJSON(res, {
          provider: 'netease', source: 'netease', url: null,
          error: '取不到播放地址（' + ((lastErr && lastErr.message) || 'VIP 或版权限制') + '）',
        });
      }
      return sendJSON(res, {
        provider: 'netease', source: 'netease',
        url: d.url || null, level: d.level || '', br: d.br || 0, type: d.type || '',
        freeTrialInfo: d.freeTrialInfo || null,
      });
    }

    // ---------- 歌词 ----------
    if (pn === '/api/lyric') {
      const id = q.get('id');
      let body = {};
      try { const nr = await lyric_new({ id, cookie: userCookie, timestamp: Date.now() }); body = nr.body || {}; } catch { /* 降级 */ }
      const lrcStr = body.lrc ? (body.lrc.lyric || '') : '';
      const tStr = body.tlyric ? (body.tlyric.lyric || '') : '';
      if (lrcStr) return sendJSON(res, { lyric: lrcStr, tlyric: tStr, yrc: body.yrc ? (body.yrc.lyric || '') : '', ytlyric: body.ytlrc ? (body.ytlrc.lyric || '') : '', source: 'lyric' });
      try {
        const r = await lyric({ id, cookie: userCookie, timestamp: Date.now() });
        const b = r.body || {};
        return sendJSON(res, { lyric: (b.lrc && b.lrc.lyric) || '', tlyric: (b.tlyric && b.tlyric.lyric) || '', source: 'lyric_new' });
      } catch (e) { return sendJSON(res, { lyric: '', tlyric: '', error: e.message }); }
    }

    // ---------- 封面代理 ----------
    if (pn === '/api/cover') {
      const cu = q.get('url') || '';
      if (!/^https?:\/\//i.test(cu)) { res.writeHead(400); return res.end(); }
      return proxyCover(res, cu);
    }

    // ---------- 扫码登录 ----------
    if (pn === '/api/login/qr/key') {
      const r = await login_qr_key({ timestamp: Date.now() });
      return sendJSON(res, { key: r.body.data.unikey });
    }
    if (pn === '/api/login/qr/create') {
      const r = await login_qr_create({ key: q.get('key'), qrimg: true, timestamp: Date.now() });
      const d = r.body.data || {};
      return sendJSON(res, { img: d.qrimg, url: d.qrurl });
    }
    if (pn === '/api/login/qr/check') {
      const key = q.get('key') || '';
      if (!key) return sendJSON(res, { code: 800, message: '二维码已失效，请刷新二维码' });
      let r, b = {}, code = 801, cookie = '';
      try {
        r = await login_qr_check({ key, timestamp: Date.now() });
        b = r.body || {};
        code = Number(b.code || 0);
        // 依赖库的 r.cookie 在某些响应里为 undefined，body.cookie 是同一份凭据的字符串形式
        if (typeof r.cookie === 'string') cookie = r.cookie;
        else if (Array.isArray(r.cookie)) cookie = r.cookie.join('; ');
        if (!cookie && b.cookie) cookie = String(b.cookie);
      } catch (e) {
        // 轮询期间网络抖动不该打断扫码，也不该把 500 抛给前端
        return sendJSON(res, { code: 801, message: '状态查询重试中…', transient: e.message });
      }
      if (code === 803) {
        if (cookie) saveCookie(cookie);
        return sendJSON(res, { code, message: b.message || '登录成功', nickname: (b.profile && b.profile.nickname) || '', saved: !!cookie });
      }
      return sendJSON(res, { code, message: b.message || '', nickname: '' });
    }

    // ---------- 登录态 ----------
    if (pn === '/api/login/status') return sendJSON(res, await getLoginInfo());
    if (pn === '/api/logout') { saveCookie(''); return sendJSON(res, { ok: true }); }

    // ==================== 登录彩蛋：暗号门 / 像素动画状态 ====================
    if (pn === '/api/login/egg/status') return sendJSON(res, loginEgg.status());
    if (pn === '/api/login/egg/event') {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const type = String(body.type || q.get('type') || '');
      const provider = String(body.provider || q.get('provider') || '');
      if (type === 'login') return sendJSON(res, loginEgg.markLogin(provider));
      if (type === 'logout') return sendJSON(res, loginEgg.markLogout(provider));
      return sendJSON(res, { ok: false, error: 'UNKNOWN_EGG_EVENT' }, 400);
    }
    if (pn === '/api/login/egg/check') {
      const body = req.method === 'POST' ? await readBody(req) : {};
      return sendJSON(res, loginEgg.check(body.phrase || q.get('phrase') || ''));
    }
    if (pn === '/api/login/egg/skip') return sendJSON(res, loginEgg.skip());
    // 隐藏唱片店：解锁条件全部由服务端事实推导（彩蛋状态 / 事件流 / 本地计数）
    if (pn === '/api/crate/status') {
      const key = tasteProfile.normalizeKey(q.get('syncKey') || '');
      const events = tasteProfile.isValidKey(key) ? tasteProfile.rawProfile(key).events : [];
      return sendJSON(res, crate.evaluate({ events }));
    }
    if (pn === '/api/crate/mark') {
      const body = await readBody(req);
      return sendJSON(res, crate.mark(body.what));
    }
    if (pn === '/api/login/egg/replay') {
      const body = req.method === 'POST' ? await readBody(req) : {};
      return sendJSON(res, loginEgg.replay(body.kind || q.get('kind') || 'first'));
    }

    // ---------- 用户歌单 ----------
    if (pn === '/api/user/playlists') {
      const info = await getLoginInfo();
      if (!info.loggedIn) return sendJSON(res, { loggedIn: false, playlists: [] });
      const r = await user_playlist({ uid: info.userId, limit: 60, cookie: userCookie, timestamp: Date.now() });
      const pls = (r.body.playlist || []).map(mapPlaylist);
      return sendJSON(res, { loggedIn: true, userId: info.userId, playlists: pls });
    }

    // ---------- 歌单详情 ----------
    if (pn === '/api/playlist/tracks') {
      const id = q.get('id');
      const limit = parseInt(q.get('limit') || '50', 10) || 50;
      const metaR = await playlist_detail({ id, cookie: userCookie, timestamp: Date.now() }).catch(() => null);
      const meta = metaR && metaR.body && metaR.body.playlist ? mapPlaylist(metaR.body.playlist) : { id };
      const r = await playlist_track_all({ id, limit, cookie: userCookie, timestamp: Date.now() });
      const tracks = (r.body.songs || []).map(mapSongRecord);
      return sendJSON(res, { playlist: meta, tracks });
    }

    // ---------- 红心 ----------
    if (pn === '/api/song/like/check') {
      const ids = String(q.get('ids') || '').split(',').filter(Boolean);
      try {
        const r = await song_like_check({ ids: JSON.stringify(ids.map(Number)), cookie: userCookie, timestamp: Date.now() });
        const data = (r.body && (r.body.data || r.body.ids)) || [];
        const likedIds = Array.isArray(data) ? data.map(String) : Object.keys(data || {}).filter(k => data[k]).map(String);
        return sendJSON(res, { likedIds });
      } catch (e) { return sendJSON(res, { likedIds: [], error: e.message }); }
    }
    if (pn === '/api/song/like') {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const id = body.id || q.get('id');
      const like = body.like !== false && String(q.get('like') || 'true') !== 'false';
      const r = await like_song({ id, like, cookie: userCookie, timestamp: Date.now() });
      const ok = r.body && (r.body.playlistSongs !== undefined || r.body.code === 200 || r.body.resources !== undefined);
      return sendJSON(res, { ok: ok !== false });
    }

    // ---------- 发现页 ----------
    if (pn === '/api/discover/home') {
      const info = await getLoginInfo();
      let daily = [];
      // 每日推荐：登录与否都先试（实测未登录也可返回）
      try {
        const r = await recommend_songs({ cookie: userCookie, timestamp: Date.now() });
        daily = ((r.body.data && r.body.data.dailySongs) || []).map(mapSongRecord);
      } catch { /* 降级 */ }
      if (!daily.length) {
        try {
          const r = await personalized_newsong({ limit: 30, cookie: userCookie, timestamp: Date.now() });
          daily = (r.body.data || []).map(mapSongRecord);
        } catch { /* 空 */ }
      }
      let pls = [];
      try {
        const r = await personalized({ limit: 10, cookie: userCookie, timestamp: Date.now() });
        pls = (r.body.result || []).map(p => ({
          id: p.id, name: p.name, cover: p.picUrl || '',
          trackCount: (p.trackCount || 0), tag: (p.type || '') , creator: '',
        }));
      } catch { /* 空 */ }
      return sendJSON(res, { loggedIn: info.loggedIn, user: info.loggedIn ? { userId: info.userId, nickname: info.nickname, avatar: info.avatar } : null, dailySongs: daily, playlists: pls });
    }

    // ==================== 汽水音乐 ====================
    if (pn === '/api/qishui/status') {
      // 自愈：票据可能在「手机确认」之后才由另一条 passport 请求种下来，
      // 那时 check 路由已经返回了。每次查登录态都补同步一次，不用重启应用。
      const qrCookie = qishuiQrLogin.getCookie();
      if (qrCookie !== qishuiCookie && qishuiQrLogin.hasLoginCookie(qrCookie)) saveQishuiCookie(qrCookie);
      const st = await qishuiApi.handleQishuiStatus(qishuiCookie);
      return sendJSON(res, Object.assign({}, st, {
        qrAvailable: QISHUI_QR_AVAILABLE,
        qrRuntime: electronRuntime.isChromiumShim ? 'chrome' : 'electron',
        qrStatus: qishuiQrLogin.getStatus(),
      }));
    }
    // 抖音 App 扫码：二维码由官方签名引擎生成，凭据落到本地后再同步给播放接口
    if (pn === '/api/qishui/login/qrcode') {
      try {
        const r = await qishuiQrLogin.createQrCode();
        const d = r.data || {};
        return sendJSON(res, {
          ok: true, provider: 'qishui', app: 'douyin',
          token: d.token || '', qrcode: d.qrcode || '', scan_url: d.scan_url || '',
          description: d.description || '',
        });
      } catch (e) {
        return sendJSON(res, { ok: false, error: e.message, code: e.code || '', qrAvailable: QISHUI_QR_AVAILABLE }, 200);
      }
    }
    if (pn === '/api/qishui/login/check') {
      try {
        const r = await qishuiQrLogin.checkQrConnect(q.get('token') || '');
        const d = r.data || {};
        // 每次都同步一次：票据由签名引擎写进扫码配置，这里负责喂给播放接口。
        // 只有含 sessionid / sid_guard 的串才算真凭据，别把一串无关 cookie
        // 当成已登录写进 .qishui-cookie。
        const cookie = qishuiQrLogin.getCookie();
        const cookieReady = qishuiQrLogin.hasLoginCookie(cookie);
        if (cookieReady) saveQishuiCookie(cookie);
        return sendJSON(res, {
          ok: true, confirmed: !!d.confirmed, cookieReady,
          reason: !cookieReady && d.confirmed ? (d.reason || '未取得登录票据') : '',
          cookieDebug: d.confirmed && !cookieReady ? (d.__cookieDebug || {}) : undefined,
          status: String(d.status || ''), error_code: d.error_code,
          description: d.description || '',
        });
      } catch (e) {
        // 二次验证取消 / 安全校验失败时把原因带回去，别让界面一直停在「等待扫码」
        return sendJSON(res, { ok: false, error: e.message, code: e.code || '' }, 200);
      }
    }
    if (pn === '/api/qishui/login/cookie') {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const c = body.cookie || q.get('cookie') || '';
      if (!c) return sendJSON(res, { ok: false, error: 'missing cookie' }, 400);
      saveQishuiCookie(qishuiApi.normalizeQishuiCookieInput(c) || c);
      return sendJSON(res, await qishuiApi.handleQishuiStatus(qishuiCookie));
    }
    if (pn === '/api/qishui/logout') {
      qishuiQrLogin.clear().catch(() => {});
      saveQishuiCookie('');
      return sendJSON(res, { ok: true });
    }
    if (pn === '/api/qishui/search') {
      const kw = q.get('keywords') || '';
      const limit = Math.min(50, parseInt(q.get('limit') || '20', 10) || 20);
      const offset = Math.max(0, parseInt(q.get('offset') || '0', 10) || 0);
      return sendJSON(res, await qishuiApi.handleQishuiSearch(kw, limit, qishuiCookie, offset));
    }
    if (pn === '/api/qishui/song/url') {
      return sendJSON(res, await qishuiApi.handleQishuiSongUrl({
        id: q.get('id') || q.get('trackId') || '',
        quality: q.get('quality') || '',
        vipRequired: q.get('vipRequired') || '',
        needVip: q.get('needVip') || '',
        onlyVipPlayable: q.get('onlyVipPlayable') || '',
        fee: q.get('fee') || '',
      }, qishuiCookie));
    }
    if (pn === '/api/qishui/lyric') return sendJSON(res, await qishuiApi.handleQishuiLyric(q.get('id') || '', qishuiCookie));

    // ==================== QQ 音乐 ====================
    if (pn === '/api/qq/status') {
      const cookie = qqApi.getQQCookie();
      return sendJSON(res, Object.assign({ provider: 'qq' }, qqApi.qqLoginInfo(), {
        channels: qqQrLogin.getChannels(),
        authorization: qqQrLogin.assessPlaybackAuth(cookie),
        playbackAuth: qqApi.qqPlaybackAuth(),
      }));
    }
    if (pn === '/api/qq/qr/channels') return sendJSON(res, { ok: true, provider: 'qq', channels: qqQrLogin.getChannels() });
    if (pn === '/api/qq/qr/create') {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const channel = String(body.channel || q.get('channel') || 'qq');
      try { return sendJSON(res, await qqQrLogin.createQr(channel)); }
      catch (e) { return sendJSON(res, { ok: false, channel, error: e.message }, 200); }
    }
    if (pn === '/api/qq/qr/check') {
      const channel = String(q.get('channel') || 'qq');
      const id = String(q.get('id') || '');
      try {
        const r = await qqQrLogin.checkQr(channel, id);
        if (r.confirmed && r.cookie) saveQQCookie(r.cookie);
        return sendJSON(res, r);
      } catch (e) { return sendJSON(res, { ok: false, status: 'error', error: e.message }, 200); }
    }
    if (pn === '/api/qq/playback/auth') return sendJSON(res, Object.assign({ ok: true, provider: 'qq' }, await qqQrLogin.probeVipStatus(qqApi.getQQCookie())));
    if (pn === '/api/qq/login/cookie') {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const c = body.cookie || q.get('cookie') || '';
      if (!c) return sendJSON(res, { ok: false, error: 'missing cookie' }, 400);
      saveQQCookie(c);
      return sendJSON(res, Object.assign({ provider: 'qq', ok: true }, qqApi.qqLoginInfo(), {
        authorization: qqQrLogin.assessPlaybackAuth(qqApi.getQQCookie()),
      }));
    }
    if (pn === '/api/qq/logout') {
      await qqQrLogin.clear();
      saveQQCookie('');
      return sendJSON(res, { ok: true });
    }
    if (pn === '/api/qq/search') {
      const kw = q.get('keywords') || '';
      const limit = Math.min(50, parseInt(q.get('limit') || '20', 10) || 20);
      const offset = Math.max(0, parseInt(q.get('offset') || '0', 10) || 0);
      return sendJSON(res, await qqApi.handleQQSearch(kw, limit, offset));
    }
    if (pn === '/api/qq/song/url') {
      return sendJSON(res, await qqApi.handleQQSongUrl(q.get('mid') || q.get('id') || '', q.get('mediaMid') || '', q.get('quality') || ''));
    }
    if (pn === '/api/qq/lyric') return sendJSON(res, await qqApi.handleQQLyric(q.get('mid') || '', q.get('id') || ''));

    // ==================== 小宇宙播客 ====================
    if (pn === '/api/xy/status') return sendJSON(res, xyApi.handleXYStatus());
    if (pn === '/api/xy/login/send-code') {
      const body = req.method === 'POST' ? await readBody(req) : {};
      try { return sendJSON(res, await xyApi.handleXYSendCode(body)); }
      catch (e) { return sendJSON(res, { ok: false, message: e.message }, 200); }
    }
    if (pn === '/api/xy/login/sms') {
      const body = req.method === 'POST' ? await readBody(req) : {};
      try { return sendJSON(res, await xyApi.handleXYLoginSMS(body)); }
      catch (e) { return sendJSON(res, { ok: false, message: e.message }, 200); }
    }
    if (pn === '/api/xy/login/token') {
      const body = req.method === 'POST' ? await readBody(req) : {};
      try { return sendJSON(res, await xyApi.handleXYSetToken(body.token || q.get('token') || '')); }
      catch (e) { return sendJSON(res, { ok: false, error: e.message }, 200); }
    }
    if (pn === '/api/xy/logout') return sendJSON(res, await xyApi.handleXYLogout());
    if (pn === '/api/xy/search') {
      const kw = q.get('keywords') || '';
      const offset = Math.max(0, parseInt(q.get('offset') || '0', 10) || 0);
      return sendJSON(res, await xyApi.handleXYSearch(kw, 20, offset));
    }
    if (pn === '/api/xy/podcast') return sendJSON(res, await xyApi.handleXYPodcast(q.get('id') || ''));
    if (pn === '/api/xy/episode') return sendJSON(res, await xyApi.handleXYEpisode(q.get('id') || ''));
    if (pn === '/api/xy/subscription') return sendJSON(res, await xyApi.handleXYSubscription(100));

    // ---------- 评论（网易云热评） ----------
    if (pn === '/api/comment') {
      const id = q.get('id');
      const limit = Math.min(30, parseInt(q.get('limit') || '20', 10) || 20);
      const offset = Math.max(0, parseInt(q.get('offset') || '0', 10) || 0);
      try {
        const r = await comment_music({ id, limit, offset, cookie: userCookie, timestamp: Date.now() });
        const b = r.body || {};
        const map = (c) => ({
          id: c.commentId, content: c.content,
          likedCount: c.likedCount || 0,
          time: c.time, user: { nickname: (c.user && c.user.nickname) || '云村村民', avatar: (c.user && c.user.avatarUrl) || '' },
        });
        return sendJSON(res, {
          total: b.total || 0,
          comments: (b.comments || []).map(map),
          hotComments: (b.hotComments || []).map(map),
        });
      } catch (e) { return sendJSON(res, { error: e.message, comments: [], hotComments: [] }, 500); }
    }

    // ==================== 音频代理（汽水解密 + QQ/跨域透传） ====================
    if (pn === '/api/audio') {
      const au = q.get('url') || '';
      if (!/^https?:\/\//i.test(au)) { res.writeHead(400); return res.end(); }
      const range = req.headers.range || '';
      // 汽水加密音频：#auth= → 解密后按 Range 发送
      const parsed = au.indexOf('#auth=') >= 0 ? qishuiAudioAuthFromUrl(au) : null;
      if (parsed && parsed.auth) {
        try {
          const payload = await getQishuiDecryptedAudio(parsed.cleanUrl, parsed.auth);
          return sendAudioBuffer(res, payload.buffer, payload.contentType, range);
        } catch (e) {
          console.error('[AudioDecrypt]', e.message);
          return sendJSON(res, { error: e.message }, 502);
        }
      }
      // 通用透传（QQ m4a、网易云外链等）
      return proxyAudio(res, au, range);
    }

    // ==================== 听感画像 / 个性化推荐（Web + macOS + iOS 共用契约） ====================
    // 契约：纯 HTTP JSON；同一服务地址 + 同一同步码 = 同一份画像。
    // 事件 id 由客户端生成，服务端去重，因此多端离线重放不会产生重复记录。
    if (pn.startsWith('/api/taste/')) {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const action = pn.slice('/api/taste/'.length);
      const key = tasteProfile.normalizeKey(body.syncKey || q.get('syncKey') || '');

      // 首次启动：发一枚新同步码，画像与推荐一次返回
      if (action === 'bootstrap' && !key) {
        const fresh = tasteProfile.createSyncKey();
        const fp = tasteProfile.rawProfile(fresh);
        return sendJSON(res, {
          ok: true, syncKey: tasteProfile.prettyKey(fresh), created: true,
          profile: tasteProfile.getProfile(fresh),
          recommendations: await tasteRecommendations(fp),
        });
      }
      if (!tasteProfile.isValidKey(key)) {
        // 首次启动时客户端可能还没有同步码：墙面与小报按「空库」回，不要甩 400
        if (action === 'wall') return sendJSON(res, wall.buildWall({ events: [], day: q.get('day') }));
        if (action === 'yearbook') return sendJSON(res, yearbook.buildYearbook({ events: [], period: q.get('period') }));
        // v2 回看数据面：没有同步码时按「空库」回，首页给动作而不是甩 400
        if (action === 'heat') return sendJSON(res, replay.buildHeat({ events: [], days: q.get('days') }));
        if (action === 'replay') return sendJSON(res, replay.buildReplay({ events: [], scope: q.get('scope') }));
        if (action === 'lastyear') return sendJSON(res, replay.buildLastYear({ events: [] }));
        if (action === 'daily') return sendJSON(res, {
          ok: true, empty: true, reason: '还没有同步码', line: '今天先挂上第一张',
          note: '去听一首，明天这里就会有属于你的一曲。',
        });
        return sendJSON(res, { ok: false, error: '同步码无效（应为 EW-XXXX-XXXX-XXXX）' }, 400);
      }
      const p = tasteProfile.rawProfile(key);

      if (action === 'bootstrap') {
        return sendJSON(res, {
          ok: true, syncKey: tasteProfile.prettyKey(key), created: false,
          profile: tasteProfile.getProfile(key),
          recommendations: await tasteRecommendations(p),
        });
      }
      if (action === 'events' && req.method === 'POST') {
        if (p.settings.enabled === false) {
          return sendJSON(res, { ok: true, accepted: 0, ignored: true, reason: '个性化已关闭' });
        }
        return sendJSON(res, tasteProfile.ingest({
          syncKey: key, deviceId: body.deviceId, platform: body.platform,
          events: body.events,
        }));
      }
      if (action === 'events') {
        return sendJSON(res, tasteProfile.getEvents(key, q.get('since'), q.get('limit')));
      }
      if (action === 'profile') return sendJSON(res, { ok: true, profile: tasteProfile.getProfile(key) });
      if (action === 'recommend') {
        const variant = Math.max(0, Math.min(20, Number(q.get('variant') || 0) || 0));
        return sendJSON(res, { ok: true, syncKey: tasteProfile.prettyKey(key), recommendations: await tasteRecommendations(p, variant) });
      }
      // 深夜频道：只取慢的，与推荐池同一套曲库检索
      if (action === 'night') {
        return sendJSON(res, await night.buildNight({
          events: p.events,
          searchFn: tasteSearch,
          isSuppressed: (song) => tasteProfile.isSuppressed(p, song),
        }));
      }
      // 唯一一处刻意「反画像」：从权重最低的方向抽一首
      if (action === 'surprise' && req.method === 'POST') {
        return sendJSON(res, await night.surprise({ events: p.events, searchFn: tasteSearch }));
      }
      // 唱片墙 / 听觉年鉴：都只读本机事件流，不做任何外部请求
      // 墙按天取（?day=YYYY-MM-DD，省略是今天）；年鉴按尺度取（?period=year|month|week）
      if (action === 'wall') return sendJSON(res, wall.buildWall({ events: p.events, day: q.get('day') }));
      if (action === 'yearbook') return sendJSON(res, yearbook.buildYearbook({ events: p.events, period: q.get('period') }));

      // ---------- v2 回听闭环：所有「回看」动作只有一个出口：加入播放队列 ----------
      // scope=day(某天墙) | period(年鉴/月鉴/周鉴那一期) | lastyear(去年今天)
      if (action === 'replay') {
        return sendJSON(res, replay.buildReplay({
          events: p.events,
          scope: q.get('scope') || 'day',
          day: q.get('day'),
          period: q.get('period') || 'month',
          offset: Number(q.get('offset')) || -1,
          source: q.get('source') || '',
          limit: Number(q.get('limit')) || 60,
        }));
      }
      if (action === 'heat') return sendJSON(res, replay.buildHeat({ events: p.events, days: q.get('days') }));
      if (action === 'lastyear') return sendJSON(res, replay.buildLastYear({ events: p.events, offset: Number(q.get('offset')) || -1 }));
      if (action === 'daily') {
        const ck = `${key}:${new Date().toDateString()}`;
        let hit = dailyCache.get(ck);
        if (!hit) {
          const d = await replay.pickDaily({ events: p.events, searchFn: tasteSearch });
          if (d.empty) return sendJSON(res, d);
          hit = { ts: Date.now(), song: d.song, reason: d.reason, line: d.line };
          dailyCache.set(ck, hit);
          if (dailyCache.size > 64) dailyCache.delete(dailyCache.keys().next().value);
        }
        // 盖章不落库：当天事件流里真播过这首，就是已听
        const d0 = new Date(); d0.setHours(0, 0, 0, 0);
        const from = d0.getTime(), to = from + 24 * 60 * 60 * 1000;
        const k = replay.songKey(hit.song);
        const heard = (p.events || []).some((e) => {
          if (!e || !['play', 'complete'].includes(e.type)) return false;
          const ts = timeOf(e);
          return ts >= from && ts < to && replay.songKey(e.song) === k;
        });
        return sendJSON(res, {
          ok: true, empty: false,
          day: `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-${String(d0.getDate()).padStart(2, '0')}`,
          song: hit.song, reason: hit.reason, line: hit.line, heard,
          note: '每天 00:00 换一张 · 播过盖章 · 只读本机记录',
        });
      }
      if (action === 'settings' && req.method === 'POST') return sendJSON(res, tasteProfile.setSettings(key, body.settings || body));
      if (action === 'feedback' && req.method === 'POST') return sendJSON(res, tasteProfile.addFeedback(key, body));
      if (action === 'clear' && req.method === 'POST') return sendJSON(res, tasteProfile.clearProfile(key, { keepSettings: body.keepSettings !== false }));
      if (action === 'export') return sendJSON(res, tasteProfile.exportProfile(key));
      if (action === 'sync-key' && req.method === 'POST') {
        if (body.mode === 'create') {
          const fresh = tasteProfile.createSyncKey();
          const merged = tasteProfile.bindSyncKey(key, fresh);
          return sendJSON(res, Object.assign({ ok: true, created: true }, merged));
        }
        const target = tasteProfile.normalizeKey(body.targetKey || '');
        if (!tasteProfile.isValidKey(target)) return sendJSON(res, { ok: false, error: '目标同步码无效' }, 400);
        return sendJSON(res, tasteProfile.bindSyncKey(key, target));
      }
      return sendJSON(res, { ok: false, error: '未知的画像接口：' + action }, 404);
    }

    // ==================== 统一音源（Web / macOS / iOS 共用契约） ====================
    // 所有平台并行检索，单个平台超时/未登录不会阻塞其它平台。
    if (pn === '/api/unified/status') return sendJSON(res, await unified.status());
    if (pn === '/api/unified/search') {
      const kw = q.get('keywords') || '';
      const limit = Math.max(4, Math.min(18, parseInt(q.get('limit') || '12', 10) || 12));
      const page = Math.max(0, Math.min(10, parseInt(q.get('page') || '0', 10) || 0));
      return sendJSON(res, await unified.search(kw, limit, page));
    }
    if (pn === '/api/unified/home') return sendJSON(res, await unified.home());
    if (pn === '/api/unified/library') return sendJSON(res, await unified.library());
    if (pn === '/api/unified/playlist') {
      return sendJSON(res, await unified.playlist(String(q.get('provider') || 'netease'), q.get('id') || ''));
    }
    if (pn === '/api/unified/alternatives') {
      return sendJSON(res, await unified.alternatives(q.get('name') || '', q.get('artist') || '', q.get('exclude') || ''));
    }

    // ---------- 静态资源 ----------
    if (pn === '/' || pn === '/app') return sendJSONRedirect(res);
    if (pn === '/favicon.ico') { res.writeHead(302, { Location: '/app/icon.svg' }); return res.end(); }
    if (pn.startsWith('/app/')) {
      const sub = pn.slice('/app'.length);
      const file = path.join(__dirname, 'web', sub === '/' ? 'index.html' : sub);
      if (!file.startsWith(path.join(__dirname, 'web'))) { res.writeHead(403); return res.end(); }
      serveStatic(res, file);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (err) {
    console.error('[Server]', pn, err.message);
    sendJSON(res, { error: err.message }, 500);
  }
});

function sendJSONRedirect(res) {
  res.writeHead(302, { Location: '/app/' });
  res.end();
}
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon',
};
function serveStatic(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// 兜底：代理、解密、第三方接口都在异步回调里跑，任何一处漏抛都会把整个进程带走
// （Electron 里 server.js 与主进程同进程，等于整个应用被关掉）。这里只记录不退出。
process.on('uncaughtException', (err) => {
  console.error('[server] uncaughtException（已拦截，服务继续运行）', (err && err.stack) || err);
});
process.on('unhandledRejection', (err) => {
  console.error('[server] unhandledRejection（已拦截，服务继续运行）', (err && err.stack) || err);
});

server.listen(PORT, HOST, () => {
  console.log('======================================================');
  console.log(' 闻曲 Earworm →  http://localhost:' + PORT + '/app/');
  console.log(' 登录态: ' + (userCookie ? '已登录(cookie已加载)' : '未登录'));
  console.log('======================================================');
});
