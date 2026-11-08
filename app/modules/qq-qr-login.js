// ====================================================================
//  QQ 音乐扫码登录（三条通道）+ VIP 播放授权评估
//
//  qq      : 手机 QQ  → ptqrshow / ptqrlogin / check_sig / authorize / QQLogin
//  wechat  : 微信     → qrconnect / long-polling / Login(tmeLoginType=1)
//  qqmusic : QQ 音乐 App → CreateQRCode / MQTT 5.0 over WebSocket / Login(tmeLoginType=6)
//
//  三条通道最终都归一成同一份本地 cookie（uin + qm_keyst/musickey/qqmusic_key），
//  由 server.js 持久化；VIP 播放授权则检查 playbackKey 是否齐备并探测会员态。
// ====================================================================
'use strict';
const https = require('https');
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MUSICU = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const PT_HOST = 'https://ssl.ptlogin2.qq.com';
const PT_APPID = '716027609';
const CONNECT_CLIENT_ID = '100497308';
const LOGIN_JUMP = 'https://graph.qq.com/oauth2.0/login_jump';
const REDIRECT_URI = 'https://y.qq.com/portal/wx_redirect.html';
const WX_APPID = 'wx48db31d50e334801';
const MQTT_URL = 'wss://mu.y.qq.com/ws/handshake';

const CHANNELS = [
  { id: 'qq', label: '手机 QQ', app: 'QQ', ttl: 120, hint: '用手机 QQ 扫一扫并在手机上确认', transport: 'http' },
  { id: 'wechat', label: '微信', app: '微信', ttl: 300, hint: '用微信扫一扫并在手机上确认', transport: 'long-poll' },
  { id: 'qqmusic', label: 'QQ 音乐 App', app: 'QQ 音乐', ttl: 300, hint: '用 QQ 音乐 App 扫一扫并在手机上确认', transport: 'mqtt' },
];

/* 会话：id → { channel, qrcode, state, message, cookie, credential, ws, ... } */
const sessions = new Map();
const MAX_SESSIONS = 24;

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */
function hash33(value, initial) {
  let h = initial || 0;
  for (const ch of String(value)) h = (h + (h << 5) + ch.charCodeAt(0)) & 0x7fffffff;
  return h;
}

function httpRequest(url, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('无效的 QQ 上游地址')); }
    const body = opts.body == null ? null
      : (Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(String(opts.body), 'utf8'));
    const headers = Object.assign({
      'User-Agent': UA,
      'Referer': 'https://y.qq.com/',
      'Accept-Encoding': 'identity',
    }, opts.headers || {});
    if (body) headers['Content-Length'] = body.length;
    const req = https.request(u, {
      method: opts.method || 'GET',
      headers,
      timeout: opts.timeout || 15000,
    }, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        headers: res.headers || {},
        body: Buffer.concat(chunks),
        text: () => Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('timeout', () => req.destroy(new Error('QQ 上游请求超时')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function cookiesOf(res) {
  const raw = res.headers['set-cookie'] || [];
  const out = {};
  for (const line of (Array.isArray(raw) ? raw : [raw])) {
    const first = String(line).split(';')[0];
    const i = first.indexOf('=');
    if (i > 0) out[first.slice(0, i).trim()] = first.slice(i + 1).trim();
  }
  return out;
}

function formEncode(obj) {
  return Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v == null ? '' : v)}`).join('&');
}

function dataUrl(body, mime) {
  if (!body || !body.length) throw new Error('二维码图片为空');
  const head = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const isPng = body.length > 8 && body.slice(0, 8).equals(head);
  const isJpeg = body[0] === 0xff && body[1] === 0xd8;
  if (!isPng && !isJpeg) throw new Error('上游返回的不是二维码图片');
  return `data:image/${mime || (isPng ? 'png' : 'jpeg')};base64,${body.toString('base64')}`;
}

/** musicu.fcg 单请求；返回 req 段的 data（不吞错误码，交给调用方判断） */
async function musicu(module, method, param, extra) {
  extra = extra || {};
  const payload = {
    comm: Object.assign({ ct: 23, cv: 0, tmeAppID: 'qqmusic' }, extra.comm || {}),
    req_1: { module, method, param: param || {} },
  };
  const r = await httpRequest(MUSICU, {
    method: 'POST',
    headers: Object.assign({
      'Content-Type': 'application/json',
      'Referer': 'https://y.qq.com/',
      'Origin': 'https://y.qq.com',
    }, extra.headers || {}),
    body: JSON.stringify(payload),
  });
  let json;
  try { json = JSON.parse(r.text()); } catch { throw new Error('QQ 音乐上游响应解析失败'); }
  const req = json.req_1 || json.req || {};
  if (extra.cookie) req.__cookie = extra.cookie;
  return { code: Number(req.code || 0), data: req.data || {}, raw: json, req };
}

/* ------------------------------------------------------------------ */
/* 凭据归一：登录回包 → 本地 cookie                                     */
/* ------------------------------------------------------------------ */
function firstNonEmpty(obj, keys) {
  for (const k of keys) {
    const v = obj && obj[k];
    if (v != null && String(v).trim() && String(v) !== '0') return String(v).trim();
  }
  return '';
}

function normalizeCredential(data, channel) {
  const d = data || {};
  const scanUser = d.scanUser || {};
  const uin = firstNonEmpty(d, ['musicid', 'str_musicid', 'uin', 'userID', 'uid', 'musicId'])
    || firstNonEmpty(scanUser, ['musicId', 'userID', 'uid']);
  const key = firstNonEmpty(d, ['musickey', 'qm_keyst', 'qqmusic_key', 'music_key', 'key', 'token', 'accessToken'])
    || firstNonEmpty(scanUser, ['accessToken', 'token']);
  const uinDigits = String(uin).replace(/\D/g, '');
  if (!uinDigits || !key) throw new Error('登录回包缺少 musicid / musickey，无法生成播放凭据');

  const parts = [
    `uin=${uinDigits}`,
    `qm_keyst=${key}`,
    `qqmusic_key=${key}`,
    `musickey=${key}`,
    `login_type=${String(d.loginType || d.login_type || (channel === 'wechat' ? 1 : channel === 'qq' ? 2 : 6))}`,
  ];
  for (const [name, value] of Object.entries({
    openid: d.openid, unionid: d.unionid, refresh_key: d.refresh_key,
    refresh_token: d.refresh_token, access_token: d.access_token,
    str_musicid: d.str_musicid || uinDigits,
  })) {
    if (value) parts.push(`${name}=${String(value)}`);
  }
  return {
    cookie: parts.join('; '),
    credential: {
      uin: uinDigits, musickey: key,
      loginType: Number(d.loginType || d.login_type || 0),
      expiresAt: Number(d.expired_at || d.keyExpiresAt || d.expiredAt || 0),
      channel,
    },
  };
}

/** VIP 播放授权评估：uin + playbackKey 齐备才算可解锁 VIP 曲目 */
function assessPlaybackAuth(cookie) {
  const obj = {};
  String(cookie || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) obj[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  });
  const uin = String(obj.uin || '').replace(/^o0*/, '').replace(/\D/g, '');
  const key = obj.qm_keyst || obj.musickey || obj.qqmusic_key || obj.music_key || '';
  const missing = [];
  if (!uin) missing.push('uin');
  if (!key) missing.push('playbackKey（qm_keyst / musickey / qqmusic_key）');
  const loggedIn = !!(uin && key);
  return {
    loggedIn,
    uin,
    hasPlaybackKey: !!key,
    vipReady: loggedIn,
    missing,
    label: loggedIn ? 'VIP 播放授权已就绪' : (uin ? '已登录但缺少播放密钥，VIP 曲目仍不可播' : '未登录，VIP 曲目不可播'),
    hint: loggedIn
      ? '登录凭据含播放密钥；VIP / 无损曲目会带上该凭据取流'
      : (uin ? '请重新扫码登录，或手动粘贴含 qm_keyst 的完整 cookie' : '扫码登录后可解锁 VIP 曲目'),
  };
}

/** 探测会员态：GetLoginUserInfo 是登录后才可用的用户信息入口 */
async function probeVipStatus(cookie) {
  const base = assessPlaybackAuth(cookie);
  if (!base.loggedIn) {
    return Object.assign({}, base, { vipKnown: false, vipLabel: '未知', isVip: false, nickname: '' });
  }
  try {
    const r = await musicu('music.UserInfo.userInfoServer', 'GetLoginUserInfo',
      { }, { comm: { ct: 19, cv: 1859, uin: base.uin }, headers: { Cookie: cookie } });
    if (r.code !== 0) {
      return Object.assign({}, base, { vipKnown: false, vipLabel: '未知', isVip: false, nickname: '', upstreamCode: r.code });
    }
    const d = r.data || {};
    const nickname = firstNonEmpty(d, ['nick', 'nickname', 'name']);
    const vipFlag = Number(d.isVip || d.vip || d.vipType || 0) > 0 || Number(d.svip || d.svipType || 0) > 0 || !!d.vipInfo;
    return Object.assign({}, base, {
      vipKnown: true,
      isVip: vipFlag,
      vipLabel: vipFlag ? (Number(d.svip || d.svipType || 0) > 0 ? 'SVIP' : 'VIP') : '普通听众',
      nickname,
    });
  } catch (e) {
    return Object.assign({}, base, { vipKnown: false, vipLabel: '未知', isVip: false, nickname: '', error: e.message });
  }
}

/* ------------------------------------------------------------------ */
/* 通道一：手机 QQ                                                     */
/* ------------------------------------------------------------------ */
async function createQQQr() {
  const url = `${PT_HOST}/ptqrshow?${formEncode({
    appid: PT_APPID, e: '2', l: 'M', s: '3', d: '72', v: '4',
    t: String(Math.random()), daid: '383', pt_3rd_aid: CONNECT_CLIENT_ID,
    u1: LOGIN_JUMP,
  })}`;
  const r = await httpRequest(url, { headers: { Referer: 'https://xui.ptlogin2.qq.com/' } });
  const qrsig = cookiesOf(r).qrsig;
  if (!qrsig) throw new Error('QQ 二维码未返回 qrsig，请稍后重试');
  return { id: qrsig, qrcode: dataUrl(r.body, 'png'), secret: qrsig, expiresIn: 120 };
}

function parsePtuiCB(text) {
  const m = /ptuiCB\(([\s\S]*?)\)\s*;?\s*$/.exec(String(text || '').trim());
  if (!m) throw new Error('QQ 扫码状态回包格式异常');
  const args = [];
  const re = /'((?:\\.|[^'\\])*)'/g;
  let hit;
  while ((hit = re.exec(m[1]))) {
    args.push(hit[1].replace(/\\x([0-9a-fA-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\u([0-9a-fA-F]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\'/g, "'"));
  }
  if (!args.length || !/^\d+$/.test(args[0])) throw new Error('QQ 扫码状态码解析失败');
  return args;
}

async function pollQQQr(qrsig) {
  const url = `${PT_HOST}/ptqrlogin?${formEncode({
    u1: LOGIN_JUMP, ptqrtoken: String(hash33(qrsig, 0)), from_ui: '1',
    aid: PT_APPID, daid: '383', pt_3rd_aid: CONNECT_CLIENT_ID,
    ptredirect: '0', h: '1', t: '1', g: '1', ptlang: '2052',
    action: `0-0-${Date.now()}`, js_ver: '20102616', js_type: '1',
    pt_uistyle: '40', has_onekey: '1',
  })}`;
  const r = await httpRequest(url, {
    headers: { Referer: 'https://xui.ptlogin2.qq.com/', Cookie: `qrsig=${qrsig}` },
  });
  const args = parsePtuiCB(r.text());
  const code = Number(args[0]);
  if (code === 66) return { status: 'waiting', message: '等待手机 QQ 扫码…' };
  if (code === 67) return { status: 'scanned', message: '已扫码，请在手机上点确认' };
  if (code === 65) return { status: 'expired', message: '二维码已过期，请刷新' };
  if (code !== 0) return { status: 'waiting', message: args[4] || '等待扫码…' };
  if (!args[2]) throw new Error('QQ 已确认但未返回鉴权链接');
  return await exchangeQQCredential(args[2]);
}

/** check_sig → (login_jump) → authorize → QQLogin */
async function exchangeQQCredential(sigInfo) {
  const uin = (/\buin=(\d+)/.exec(sigInfo) || [])[1] || '';
  const ptsigx = (/[?&]ptsigx=([^&]+)/.exec(sigInfo) || [])[1] || '';
  let checkSigUrl = sigInfo;
  if (ptsigx) {
    checkSigUrl = `https://ssl.ptlogin2.graph.qq.com/check_sig?${formEncode({
      uin, pttype: '1', service: 'ptqrlogin', nodirect: '0', ptsigx,
      s_url: LOGIN_JUMP, ptlang: '2052', ptredirect: '100', aid: PT_APPID,
      daid: '383', j_later: '0', low_login_hour: '0', regmaster: '0',
      pt_login_type: '3', pt_aid: '0', pt_aaid: '16', pt_light: '0',
      pt_3rd_aid: CONNECT_CLIENT_ID,
    })}`;
  } else if (!/^https:\/\/ssl\.ptlogin2\.graph\.qq\.com\/check_sig\?/.test(sigInfo)) {
    throw new Error('QQ 鉴权链接不在可信域名内');
  }

  const checked = await httpRequest(checkSigUrl, {
    headers: { Referer: 'https://xui.ptlogin2.qq.com/' },
  });
  const graphCookies = cookiesOf(checked);
  const pSkey = graphCookies.p_skey || '';
  if (!pSkey) throw new Error('QQ 登录态换取失败（缺少 p_skey），请重新扫码');
  const graphCookie = Object.entries(graphCookies)
    .filter(([k]) => ['p_uin', 'p_skey', 'pt_oauth_token'].includes(k))
    .map(([k, v]) => `${k}=${v}`).join('; ');

  const jump = checked.headers.location && /^https:\/\/graph\.qq\.com\/oauth2\.0\/login_jump/.test(checked.headers.location)
    ? checked.headers.location : '';
  if (jump) {
    await httpRequest(jump, { headers: { Cookie: graphCookie, Referer: 'https://graph.qq.com/' } }).catch(() => {});
  }

  const state = crypto.randomBytes(8).toString('hex');
  const redirect = `${REDIRECT_URI}?${formEncode({ login_type: '1', surl: 'https://y.qq.com/' })}`;
  const authorized = await httpRequest('https://graph.qq.com/oauth2.0/authorize', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: graphCookie,
      Referer: 'https://graph.qq.com/',
    },
    body: formEncode({
      response_type: 'code', client_id: CONNECT_CLIENT_ID, redirect_uri: redirect,
      scope: 'get_user_info,get_app_friends', state, switch: '', from_ptlogin: '1',
      src: '1', update_auth: '1', openapi: '1010_1030',
      g_tk: String(hash33(pSkey, 5381)), auth_time: String(Date.now()), ui: crypto.randomUUID(),
    }),
  });
  const location = String(authorized.headers.location || '');
  const code = (/[?&]code=([A-Fa-f0-9]{32})/.exec(location) || [])[1] || '';
  if (!code) throw new Error('QQ 互联未返回授权 code，请重新扫码');

  const r = await musicu('QQConnectLogin.LoginServer', 'QQLogin', { code }, { comm: { tmeLoginType: 2 } });
  if (r.code !== 0) throw new Error(`QQ 登录凭证换取失败（${r.code}）`);
  const out = normalizeCredential(r.data, 'qq');
  return { status: 'confirmed', message: '✓ 手机 QQ 登录成功，凭据已存到本机', ...out };
}

/* ------------------------------------------------------------------ */
/* 通道二：微信                                                        */
/* ------------------------------------------------------------------ */
async function createWechatQr() {
  const url = `https://open.weixin.qq.com/connect/qrconnect?${formEncode({
    appid: WX_APPID,
    redirect_uri: `${REDIRECT_URI}?login_type=2&surl=https://y.qq.com/`,
    response_type: 'code', scope: 'snsapi_login', state: 'STATE',
    href: 'https://y.qq.com/mediastyle/music_v17/src/css/popup_wechat.css#wechat_redirect',
  })}`;
  const page = await httpRequest(url, { headers: { Referer: 'https://y.qq.com/' } });
  // 官网页面把 uuid 写在二维码 img 的 src 上；JS 里也有 uuid= 字样，但那不是真值，必须优先取 img
  const html = page.text();
  const uuid = (/src=["']\/connect\/qrcode\/([A-Za-z0-9_-]+)["']/.exec(html) || [])[1]
    || (/uuid=([A-Za-z0-9_-]{8,})/.exec(html) || [])[1]
    || (/uuid\s*[:=]\s*["']([A-Za-z0-9_-]{8,})["']/.exec(html) || [])[1] || '';
  if (!uuid) throw new Error('微信二维码未返回 uuid，请稍后重试');
  const img = await httpRequest(`https://open.weixin.qq.com/connect/qrcode/${encodeURIComponent(uuid)}`, {
    headers: { Referer: 'https://open.weixin.qq.com/connect/qrconnect' },
  });
  return { id: uuid, qrcode: dataUrl(img.body, 'jpeg'), secret: uuid, expiresIn: 300 };
}

async function pollWechatQr(uuid) {
  let r;
  try {
    r = await httpRequest(`https://lp.open.weixin.qq.com/connect/l/qrconnect?uuid=${encodeURIComponent(uuid)}&_=${Date.now()}`, {
      headers: { Referer: 'https://open.weixin.qq.com/' },
      timeout: 12000,
    });
  } catch (e) {
    // 长轮询超时＝仍未被扫描，属于正常状态
    if (/超时|timeout/i.test(e.message)) return { status: 'waiting', message: '等待微信扫码…' };
    throw e;
  }
  const text = r.text();
  const m = /window\.wx_errcode=(\d+);window\.wx_code='([^']*)'/.exec(text);
  if (!m) return { status: 'waiting', message: '等待微信扫码…' };
  const errcode = Number(m[1]);
  if (errcode === 408) return { status: 'waiting', message: '等待微信扫码…' };
  if (errcode === 404) return { status: 'scanned', message: '已扫码，请在手机上点确认' };
  if (errcode === 402) return { status: 'expired', message: '二维码已过期，请刷新' };
  if (errcode === 403) return { status: 'canceled', message: '已取消授权，请刷新二维码' };
  if (errcode !== 405) return { status: 'waiting', message: '等待微信确认…' };
  const wxCode = m[2];
  if (!wxCode) throw new Error('微信未返回授权 code');
  const res = await musicu('music.login.LoginServer', 'Login',
    { code: wxCode, strAppid: WX_APPID }, { comm: { tmeLoginType: 1 } });
  if (res.code !== 0) throw new Error(`微信登录凭证换取失败（${res.code}）`);
  const out = normalizeCredential(res.data, 'wechat');
  return { status: 'confirmed', message: '✓ 微信登录成功，凭据已存到本机', ...out };
}

/* ------------------------------------------------------------------ */
/* 通道三：QQ 音乐 App（MQTT 5.0 over WebSocket）                       */
/* ------------------------------------------------------------------ */
function varInt(value) {
  const bytes = [];
  let n = value;
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    bytes.push(b);
  } while (n > 0);
  return Buffer.from(bytes);
}
function readVarInt(buf, pos) {
  let value = 0, mul = 1, b = 0;
  do {
    b = buf[pos++];
    value += (b & 127) * mul;
    mul *= 128;
  } while ((b & 128) !== 0 && pos < buf.length);
  return [value, pos];
}
function mqttString(value) {
  const b = Buffer.from(String(value), 'utf8');
  return Buffer.concat([Buffer.from([b.length >> 8, b.length & 255]), b]);
}
function userProperty(key, value) {
  return Buffer.concat([Buffer.from([0x26]), mqttString(key), mqttString(value)]);
}
function properties(...items) {
  const body = Buffer.concat(items);
  return Buffer.concat([varInt(body.length), body]);
}
function mqttPacket(type, body) {
  return Buffer.concat([Buffer.from([type]), varInt(body.length), body]);
}

function parsePublish(buf) {
  const [len, start] = readVarInt(buf, 1);
  const end = start + len;
  if (end > buf.length) return null;
  let p = start;
  const topicLen = buf.readUInt16BE(p); p += 2;
  const topic = buf.slice(p, p + topicLen).toString('utf8'); p += topicLen;
  const qos = (buf[0] >> 1) & 3;
  if (qos > 0) p += 2;
  const [propLen, pp] = readVarInt(buf, p);
  p = pp;
  const propEnd = Math.min(p + propLen, end);
  const userProps = {};
  while (p < propEnd) {
    const id = buf[p++];
    if (id !== 0x26) { p = propEnd; break; } // 未知属性：不再猜测，直接跳到载荷
    const kl = buf.readUInt16BE(p); p += 2;
    const key = buf.slice(p, p + kl).toString('utf8'); p += kl;
    const vl = buf.readUInt16BE(p); p += 2;
    const value = buf.slice(p, p + vl).toString('utf8'); p += vl;
    userProps[key] = value;
  }
  let payload = null;
  try { payload = JSON.parse(buf.slice(propEnd, end).toString('utf8')); } catch { /* 非 JSON 消息忽略 */ }
  return { topic, userProps, payload, end };
}

async function exchangeAppCredential(qrcodeID, uin, token) {
  const r = await musicu('music.login.LoginServer', 'Login',
    { musicid: Number(String(uin).replace(/\D/g, '')) || 0, qrCodeID: qrcodeID, token: String(token) },
    { comm: { tmeLoginType: 6 } });
  if (r.code !== 0) throw new Error(`QQ 音乐 App 登录凭证换取失败（${r.code}）`);
  return normalizeCredential(r.data, 'qqmusic');
}

/** App 通道的 HTTP 轮询兜底：官方对普通客户端有 ct 白名单，拿不到状态时如实返回 */
async function pollAppQrStatus(qrcodeID) {
  try {
    const r = await musicu('music.login.LoginServer', 'GetQRCodeStatus',
      { tmeAppID: 'qqmusic', qrCodeID: qrcodeID });
    if (r.code !== 0) return null;
    const info = (r.data || {}).info || {};
    const status = String(info.status || '').toLowerCase();
    if (/confirm|done|success|login/.test(status)) {
      const su = info.scanUser || {};
      const uin = info.uid || su.musicId || su.userID || '';
      const token = info.token || su.accessToken || '';
      if (uin && token) return await exchangeAppCredential(qrcodeID, uin, token);
    }
    if (/scan/.test(status)) return { status: 'scanned', message: '已扫码，请在手机上点确认' };
    if (/expire|timeout/.test(status)) return { status: 'expired', message: '二维码已过期，请刷新' };
  } catch { /* 兜底失败不影响 MQTT 主链路 */ }
  return null;
}

function startMqttSession(session) {
  const qid = session.id;
  if (typeof WebSocket !== 'function') {
    session.mqttError = '当前 Node 版本不支持 WebSocket，App 通道需 Node 22+';
    return;
  }
  const clientId = `${Date.now()}${Math.floor(Math.random() * 9000) + 1000}`;
  const topic = `management.qrcode_login/${qid}`;
  let ws;
  try { ws = new WebSocket(MQTT_URL, 'mqtt'); }
  catch (e) { session.mqttError = `MQTT 连接失败：${e.message}`; return; }
  ws.binaryType = 'arraybuffer';
  session.ws = ws;
  let buffer = Buffer.alloc(0);
  let settled = false;

  const finish = (result) => {
    if (settled) return;
    const phase = result.state || result.status || '';
    if (phase === 'confirmed' || phase === 'expired' || phase === 'canceled') settled = true;
    Object.assign(session, result);
    if (settled) {
      if (session.closeTimer) { clearTimeout(session.closeTimer); session.closeTimer = null; }
      try { ws.close(); } catch { /* 已关闭 */ }
    }
  };

  ws.addEventListener('open', () => {
    const connectProps = properties(
      Buffer.concat([Buffer.from([0x15]), mqttString('pass')]),
      userProperty('tmeAppID', 'qqmusic'),
      userProperty('business', 'management'),
      userProperty('hashTag', qid),
      userProperty('clientTag', 'management.user'),
      userProperty('userID', qid),
    );
    const variable = Buffer.concat([
      mqttString('MQTT'), Buffer.from([5, 0x02, 0x00, 45]), connectProps,
    ]);
    ws.send(mqttPacket(0x10, Buffer.concat([variable, mqttString(clientId)])));
    session.state = 'waiting';
    session.message = '等待 QQ 音乐 App 扫码…';
  });

  ws.addEventListener('message', async (event) => {
    const chunk = Buffer.from(event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : event.data);
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    while (buffer.length >= 2) {
      const [len, start] = readVarInt(buffer, 1);
      const end = start + len;
      if (end > buffer.length) break;
      const packet = buffer.slice(0, end);
      buffer = buffer.slice(end);
      const type = packet[0] >> 4;
      if (type === 12 && packet[0] === 0xc0) { try { ws.send(Buffer.from([0xd0, 0x00])); } catch {} continue; }
      if (type === 2) { // CONNACK：确认后发 SUBSCRIBE
        const vh = Buffer.concat([
          Buffer.from([0x00, 0x01]),
          properties(userProperty('authorization', 'tmelogin'), userProperty('pubsub', 'unicast')),
        ]);
        try { ws.send(mqttPacket(0x82, Buffer.concat([vh, mqttString(topic), Buffer.from([0x00])]))); } catch {}
        continue;
      }
      if (type === 9) continue; // SUBACK
      if (type !== 3) continue; // 只处理 PUBLISH
      const msg = parsePublish(packet);
      if (!msg) continue;
      const kind = msg.userProps.type || '';
      const body = msg.payload || {};
      if (kind === 'scanned') { finish({ state: 'scanned', message: '已扫码，请在手机上点确认' }); continue; }
      if (kind === 'canceled') { finish({ state: 'canceled', message: '已取消授权，请刷新二维码' }); continue; }
      if (kind === 'timeout') { finish({ state: 'expired', message: '二维码已过期，请刷新' }); continue; }
      if (kind === 'loginFailed') { finish({ state: 'error', message: 'App 侧登录失败，请重试' }); continue; }
      if (kind !== 'cookies') continue;
      const cookies = body.cookies || {};
      const uin = (cookies.qqmusic_uin || {}).value || '';
      const token = (cookies.qqmusic_key || {}).value || '';
      if (!uin || !token) { finish({ state: 'error', message: 'App 未回传完整登录凭据' }); continue; }
      try {
        const out = await exchangeAppCredential(qid, uin, token);
        finish({ state: 'confirmed', message: '✓ QQ 音乐 App 登录成功，凭据已存到本机', ...out });
      } catch (e) { finish({ state: 'error', message: `凭据换取失败：${e.message}` }); }
    }
  });

  ws.addEventListener('error', () => {
    if (!settled) session.mqttError = 'MQTT 长连接异常，可改用手机 QQ / 微信通道，或手动粘贴 cookie';
  });
  ws.addEventListener('close', () => {
    if (!settled && session.state !== 'confirmed') {
      session.mqttError = session.mqttError || 'MQTT 连接已断开，请刷新二维码重试';
    }
  });
  // 二维码生命周期结束后断开，避免长连接悬挂
  session.closeTimer = setTimeout(() => {
    try { ws.close(); } catch {}
    if (session.state === 'waiting') session.state = 'expired';
    if (session.state === 'expired' && !session.message.includes('过期')) session.message = '二维码已过期，请刷新';
  }, 300000);
  if (session.closeTimer.unref) session.closeTimer.unref();
}

function closeSession(session) {
  if (!session) return;
  try { if (session.ws) session.ws.close(); } catch {}
  if (session.closeTimer) clearTimeout(session.closeTimer);
}

function pruneSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > 360000 || sessions.size > MAX_SESSIONS) {
      closeSession(s); sessions.delete(id);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */
function getChannels() {
  return CHANNELS.map(c => ({ ...c, available: c.transport !== 'mqtt' || typeof WebSocket === 'function' }));
}

async function createQr(channel) {
  const meta = CHANNELS.find(c => c.id === channel);
  if (!meta) throw new Error('未知的 QQ 登录通道');
  pruneSessions();
  for (const [id, s] of sessions) {
    if (s.channel === channel) { closeSession(s); sessions.delete(id); }
  }
  let out;
  if (channel === 'qq') out = await createQQQr();
  else if (channel === 'wechat') out = await createWechatQr();
  else {
    const r = await musicu('music.login.LoginServer', 'CreateQRCode', { tmeAppID: 'qqmusic' });
    const d = r.data || {};
    const qrcode = String(d.qrcode || '');
    const qid = String(d.qrcodeID || d.qrCodeID || '');
    if (!qrcode || !qid) throw new Error(`QQ 音乐 App 二维码生成失败（${r.code}）`);
    out = { id: qid, qrcode: qrcode.startsWith('data:') ? qrcode : `data:image/png;base64,${qrcode.split(',').pop()}`, secret: qid, expiresIn: 300 };
  }
  const session = {
    channel, id: out.id, qrcode: out.qrcode, secret: out.secret,
    expiresIn: out.expiresIn, createdAt: Date.now(),
    state: 'waiting', message: meta.hint, cookie: '', credential: null,
    ws: null, closeTimer: null, mqttError: '',
  };
  sessions.set(out.id, session);
  if (channel === 'qqmusic') startMqttSession(session);
  return { ok: true, provider: 'qq', channel, label: meta.label, app: meta.app, id: out.id, qrcode: out.qrcode, expiresIn: out.expiresIn, hint: meta.hint };
}

async function checkQr(channel, id) {
  const session = sessions.get(String(id || ''));
  if (!session || session.channel !== channel) {
    return { ok: false, status: 'expired', message: '二维码会话已失效，请刷新二维码' };
  }
  if (session.state === 'confirmed') {
    return { ok: true, status: 'confirmed', message: session.message, cookie: session.cookie, credential: session.credential, authorization: assessPlaybackAuth(session.cookie) };
  }
  let result = null;
  try {
    if (channel === 'qq') result = await pollQQQr(session.secret);
    else if (channel === 'wechat') result = await pollWechatQr(session.secret);
    else {
      result = await pollAppQrStatus(session.secret);
      if (!result) {
        result = {
          status: session.state === 'error' ? 'error' : session.state,
          message: session.message + (session.mqttError ? `（${session.mqttError}）` : ''),
        };
      }
    }
  } catch (e) {
    return { ok: false, status: 'error', message: e.message };
  }
  const status = result.status || 'waiting';
  session.state = status;
  session.message = result.message || session.message;
  if (result.cookie) {
    session.cookie = result.cookie;
    session.credential = result.credential;
    closeSession(session);
  }
  return {
    ok: true, status, message: session.message,
    confirmed: status === 'confirmed',
    cookie: status === 'confirmed' ? session.cookie : '',
    credential: status === 'confirmed' ? session.credential : null,
    authorization: status === 'confirmed' ? assessPlaybackAuth(session.cookie) : null,
  };
}

function clear() {
  for (const s of sessions.values()) closeSession(s);
  sessions.clear();
  return Promise.resolve({ ok: true });
}

module.exports = {
  getChannels, createQr, checkQr, clear,
  assessPlaybackAuth, probeVipStatus, normalizeCredential,
};
