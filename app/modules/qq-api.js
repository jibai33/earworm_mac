// ====================================================================
//  QQ 音乐精简客户端（闻曲 Earworm）
//  - 搜索: musicu.fcg DoSearchForQQMusicDesktop
//  - 播放: vkey.GetVkey (C600/M800/F000 逐级尝试, cookie 可提升音质)
//  - 歌词: music.musichallSong.PlayLyricInfo
//  - 登录: cookie 粘贴（含 uin + qm_keyst/musickey）
// ====================================================================
const https = require('https');
const crypto = require('crypto');

const QQ_MUSICU_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const QQ_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Referer': 'https://y.qq.com/',
  'Content-Type': 'application/json',
};

/* ---------- cookie ---------- */
let qqCookie = '';
function setQQCookie(c) { qqCookie = String(c || '').trim(); }
function getQQCookie() { return qqCookie; }
function qqCookieObject() {
  const out = {};
  String(qqCookie || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  });
  return out;
}
function qqLoginInfo() {
  const obj = qqCookieObject();
  const uin = obj.uin ? obj.uin.replace(/^o0*/, '') : '';
  const key = obj.qm_keyst || obj.musickey || obj.qqmusic_key || '';
  return { loggedIn: !!(uin && key), uin, nickname: obj.nickname || '', avatar: obj['qqmusic_avatar'] || '' };
}

/* ---------- 请求 ---------- */
function qqMusicPost(payload, cookie) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const url = new URL(QQ_MUSICU_URL);
    const headers = Object.assign({}, QQ_HEADERS, { 'Content-Length': Buffer.byteLength(data) });
    const c = cookie || qqCookie;
    if (c) headers.Cookie = c;
    const req = https.request(url, { method: 'POST', headers, timeout: 10000 }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('QQ 响应解析失败')); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('QQ 请求超时')); });
    req.on('error', reject);
    req.end(data);
  });
}

/* ---------- 搜索 ---------- */
function mapQQSong(t) {
  t = t || {};
  const album = t.album || {};
  const singers = (t.singer || []).map(s => s.name).filter(Boolean);
  return {
    provider: 'qq', source: 'qq', type: 'song',
    id: t.songmid || t.mid || '',
    mid: t.songmid || t.mid || '',
    mediaMid: (t.file && t.file.media_mid) || t.media_mid || (album.mid || t.albummid || ''),
    // 新版搜索只回 id（数字），老接口才叫 songid；评论要用这个数字 id 当 topid
    songId: t.id || t.songid || 0,
    name: t.songname || t.name || '',
    artist: singers.join(' / ') || '未知歌手',
    album: album.name || '',
    albumMid: album.mid || '',
    cover: album.mid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${album.mid}.jpg` : '',
    duration: (t.interval || 0) * 1000,
    fee: t.pay ? (t.pay.pay_play ? 1 : 0) : 0,
  };
}
async function handleQQSearch(keywords, limit, offset) {
  const reqId = Math.floor(Math.random() * 900000) + 100000;
  const payload = {
    comm: { ct: 19, cv: 1859, uin: qqLoginInfo().uin || '0' },
    req_1: {
      method: 'DoSearchForQQMusicDesktop',
      module: 'music.search.SearchCgiService',
      param: { search_type: 0, query: String(keywords || ''), page_num: Math.floor((offset || 0) / Math.max(limit, 1)) + 1, num_per_page: limit },
    },
  };
  const r = await qqMusicPost(payload);
  const body = (((r.req_1 || {}).data || {}).body) || {};
  const list = (body.song && body.song.list) || [];
  return { provider: 'qq', songs: list.map(mapQQSong), hasMore: list.length >= limit };
}

/* ---------- 播放地址 / VIP 播放授权 ---------- */
// 官方 vkey 要求两段式文件名：前缀 + songmid + media_mid + 扩展名，
// 只送单段会拿到 purl，但 CDN 一律 403。
const QQ_FILENAME_TIERS = [
  ['F000', 'flac'],  // 无损（需会员 + 播放密钥）
  ['M800', 'mp3'],   // 320k
  ['M500', 'mp3'],   // 128k
  ['C400', 'm4a'],   // 试听兜底
];
const QQ_STREAM_FALLBACKS = [
  'http://dl.stream.qqmusic.qq.com/',
  'http://sjy6.stream.qqmusic.qq.com/',
  'http://ws.stream.qqmusic.qq.com/',
];
function playbackKeyOf() {
  const obj = qqCookieObject();
  return obj.qm_keyst || obj.musickey || obj.qqmusic_key || obj.music_key || '';
}
function qqPlaybackAuth() {
  const info = qqLoginInfo();
  const key = playbackKeyOf();
  return {
    loggedIn: !!(info.uin && key),
    uin: info.uin || '',
    hasPlaybackKey: !!key,
    vipReady: !!(info.uin && key),
  };
}
function qqFilename(tier, mid, mediaMid) {
  const [prefix, ext] = tier;
  return `${prefix}${mid}${mediaMid || mid}.${ext}`;
}
function pickStreamUrl(data, filenames) {
  const items = Array.isArray(data.midurlinfo) ? data.midurlinfo : [];
  const rawSips = Array.isArray(data.sip) ? data.sip.filter(Boolean) : [];
  const sips = rawSips.filter(s => !String(s).includes('ws.stream'))
    .concat(rawSips, QQ_STREAM_FALLBACKS);
  const order = ['F000', 'M800', 'M500', 'C400'];
  const sorted = items.filter(it => it && it.purl).sort((a, b) => {
    const ai = order.findIndex(p => String(a.filename || '').startsWith(p));
    const bi = order.findIndex(p => String(b.filename || '').startsWith(p));
    return (ai < 0 ? 9 : ai) - (bi < 0 ? 9 : bi);
  });
  for (const it of sorted) {
    const fn = String(it.filename || '');
    // 只按文件名前缀判定档位；上游偶尔不回 filename，此时按申请列表的首档兜底
    const prefix = order.find(p => fn.startsWith(p)) || (/^[A-Z]\d{3}/.exec(filenames[0] || '') || [])[0] || '';
    const level = prefix === 'F000' ? '无损' : prefix === 'M800' ? 'HQ' : prefix === 'M500' ? '320k' : '标准';
    const domain = String(sips[0]).replace(/\/?$/, '/');
    return { url: `${domain}${it.purl}`, level };
  }
  return null;
}
async function requestQQVkey(filenames, mid, guid, uin, modern) {
  const param = modern ? {
    filename: filenames, guid, songmid: filenames.map(() => mid),
    songtype: filenames.map(() => 0), uin: uin || '0', ctx: 0,
  } : {
    guid, songmid: filenames.map(() => mid), songtype: filenames.map(() => 0),
    uin, loginflag: 1, platform: '20', filename: filenames,
  };
  const payload = {
    comm: modern
      ? { ct: 23, cv: 0, uin: uin || '0', tmeAppID: 'qqmusic' }
      : { uin, format: 'json', ct: uin && uin !== '0' ? 19 : 24, cv: 0 },
    req_0: {
      module: modern ? 'music.vkey.GetVkey' : 'vkey.GetVkeyServer',
      method: modern ? 'UrlGetVkey' : 'CgiGetVkey',
      param,
    },
  };
  const r = await qqMusicPost(payload, qqCookie);
  return (((r.req_0 || {}).data || {}) || {});
}
async function handleQQSongUrl(mid, mediaMid, qualityHint) {
  if (!mid) return { provider: 'qq', url: '', playable: false, error: 'Missing song mid' };
  const auth = qqPlaybackAuth();
  const uin = auth.uin || '0';
  const guid = String(10000000 + Math.floor(Math.random() * 90000000));
  const wantLossless = qualityHint === 'lossless';
  // 未登录只用试听兜底；登录后按音质从高到低申请，让 VIP 播放密钥参与取流
  const tiers = !auth.vipReady ? [['C400', 'm4a']]
    : wantLossless ? QQ_FILENAME_TIERS : QQ_FILENAME_TIERS.filter(t => t[0] !== 'F000');
  const filenames = tiers.map(t => qqFilename(t, mid, mediaMid));

  let data = {};
  const errors = [];
  // 已授权优先走新版 UrlGetVkey（读 musickey），失败再退回旧版 CgiGetVkey
  const attempts = auth.vipReady ? [true, false] : [false];
  for (const modern of attempts) {
    try { data = await requestQQVkey(filenames, mid, guid, uin, modern); }
    catch (e) { errors.push(e.message); continue; }
    if (pickStreamUrl(data, filenames)) break;
  }
  const picked = pickStreamUrl(data, filenames);
  if (!picked) {
    const reason = !auth.loggedIn
      ? '取不到播放地址：该曲目可能需要 QQ 音乐登录授权（VIP / 版权限制）'
      : !auth.hasPlaybackKey
        ? '取不到播放地址：凭据缺少播放密钥（qm_keyst），请重新扫码登录'
        : '取不到播放地址：账号可能无该曲目的 VIP 播放授权，或上游暂时不可用';
    return {
      provider: 'qq', url: '', playable: false, level: '',
      error: reason, authorization: auth,
      detail: errors.length ? errors.join('；') : '',
    };
  }
  return {
    provider: 'qq', url: picked.url, playable: true, level: picked.level,
    authorization: auth, vipUnlocked: auth.vipReady && picked.level !== '标准',
  };
}

/* ---------- 歌词 ---------- */
async function handleQQLyric(mid, songId) {
  if (!mid && !songId) return { provider: 'qq', lyric: '' };
  const payload = {
    comm: { ct: 19, cv: 1859, uin: qqLoginInfo().uin || '0' },
    req_1: {
      module: 'music.musichallSong.PlayLyricInfo',
      method: 'GetPlayLyricInfo',
      param: { songMID: mid || '', songID: Number(songId) || 0, transmit: 1, qrc: 1, ct: 19, cv: 1859 },
    },
  };
  const r = await qqMusicPost(payload);
  const d = (((r.req_1 || {}).data || {}) || {});
  const lyric = d.lyric ? Buffer.from(String(d.lyric), 'base64').toString('utf8') : (d.lyric || '');
  const trans = d.trans ? Buffer.from(String(d.trans), 'base64').toString('utf8') : '';
  return { provider: 'qq', lyric, tlyric: trans };
}

/* ---------- 评论 ----------
   QQ 的评论走老 fcg 接口（musicu 那套 globalComment 模块现在回 500003）：
     cmd=6 热评 / cmd=8 最新（含热评，带总数）/ cmd=1 发表（登录校验在前，未登录直接 1000）
   发表只能靠用户自己的登录 cookie，这里不伪造任何凭据。 */
const QQ_COMMENT_URL = 'https://c.y.qq.com/base/fcgi-bin/fcg_global_comment_h5.fcg';
function qqCommentParams(extra) {
  return Object.assign({
    g_tk: 5381, g_tk_new_20200303: 5381, loginUin: 0, hostUin: 0,
    format: 'json', inCharset: 'utf8', outCharset: 'utf-8', notice: 0,
    platform: 'yqq.json', needNewCode: 0, domain: 'qq.com',
    ct: 24, cv: 10101010, reqtype: 2, biztype: 1, needmusiccrit: 0, lasthotcommentid: '',
  }, extra);
}
function qqCommentFetch(params, cookie, method) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params).toString();
    const isPost = method === 'POST';
    const url = new URL(QQ_COMMENT_URL + (isPost ? '' : '?' + qs));
    const headers = Object.assign({}, QQ_HEADERS, {
      'Referer': 'https://y.qq.com/', 'Accept': 'application/json, text/javascript, */*',
    });
    if (isPost) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(qs);
    }
    const c = cookie === undefined ? qqCookie : cookie;
    if (c) headers.Cookie = c;
    const req = https.request(url, { method: isPost ? 'POST' : 'GET', headers, timeout: 12000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { reject(new Error('QQ 评论响应解析失败')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('QQ 评论请求超时')));
    req.on('error', reject);
    req.end(isPost ? qs : undefined);
  });
}
function mapQQComment(c) {
  c = c || {};
  const uid = String(c.encrypt_uin || '').replace(/\*+$/, '');
  return {
    id: String(c.commentid || c.rootcommentid || uid + '_' + (c.time || '')),
    content: String(c.rootcommentcontent || c.content || '').trim(),
    likedCount: Number(c.praisenum || 0) || 0,
    time: (Number(c.time) || 0) * 1000,
    isHot: !!(c.is_hot_cmt || c.is_stick),
    reply: c.middlecommentcontent ? String(c.middlecommentcontent).trim() : '',
    user: {
      nickname: String(c.nick || c.rootcommentnick || 'QQ 音乐用户').replace(/^@/, ''),
      avatar: String(c.avatarurl || ''),
    },
  };
}
function qqCommentTotal(body) {
  const d = (body && body.comment) || {};
  const n = Number(d.commenttotal || (body && body.commenttotal) || 0);
  return Number.isFinite(n) ? n : 0;
}
async function handleQQComments(songId, opts, cookie) {
  const topid = Number(songId) || 0;
  if (!topid) {
    return { provider: 'qq', total: 0, comments: [], hotComments: [], hasMore: false, error: '缺少 QQ 歌曲数字 id（songId），无法定位评论区' };
  }
  opts = opts || {};
  const limit = Math.max(1, Math.min(50, Number(opts.limit) || 20));
  const page = Math.max(0, Number(opts.page) || 0);
  const wantHot = opts.type === 'hot' || page === 0;
  const out = { provider: 'qq', total: 0, comments: [], hotComments: [], page, hasMore: false, loggedIn: qqLoginInfo().loggedIn };

  const latest = await qqCommentFetch(qqCommentParams({ cmd: 8, topid, pagenum: page, pagesize: limit }), cookie, 'GET');
  if (latest && latest.code === 1000) return Object.assign(out, { error: 'QQ 评论需要登录后才能查看' });
  if (!latest || (latest.code && latest.code !== 0)) {
    return Object.assign(out, { error: 'QQ 评论暂时取不到（' + ((latest && (latest.msg || latest.code)) || '未知原因') + '）' });
  }
  const latestList = ((latest.comment || {}).commentlist) || [];
  out.total = qqCommentTotal(latest);
  out.comments = latestList.map(mapQQComment).filter(c => c.content);
  out.hasMore = out.comments.length >= limit && out.total > page * limit + out.comments.length;

  if (wantHot) {
    try {
      const hot = await qqCommentFetch(qqCommentParams({ cmd: 6, topid, pagenum: 0, pagesize: limit }), cookie, 'GET');
      const hotList = ((hot && hot.comment || {}).commentlist) || [];
      // cmd=6 本身就是「热评榜」，逐条补上标记；不能再按 is_hot 判，
      // 最新列表里几乎每条都带 is_hot=1，全标成热评等于没标
      out.hotComments = hotList.map(mapQQComment).filter(c => c.content).map(c => Object.assign({}, c, { isHot: true }));
    } catch { out.hotComments = []; }
  }
  return out;
}
async function handleQQPostComment(songId, content, cookie) {
  const topid = Number(songId) || 0;
  const text = String(content || '').trim();
  if (!topid) return { ok: false, provider: 'qq', error: '缺少 QQ 歌曲数字 id，无法发表评论' };
  if (!text) return { ok: false, provider: 'qq', error: '评论内容不能为空' };
  if (text.length > 300) return { ok: false, provider: 'qq', error: 'QQ 评论最多 300 字' };
  const login = qqLoginInfo();
  if (!login.loggedIn) {
    return { ok: false, provider: 'qq', needLogin: true, error: '需要登录 QQ 音乐才能发评论' };
  }
  let r;
  try {
    r = await qqCommentFetch(qqCommentParams({ cmd: 1, topid, content: text, pagenum: 0, pagesize: 15 }), cookie, 'POST');
  } catch (e) {
    return { ok: false, provider: 'qq', error: '发送失败：' + e.message };
  }
  const code = Number(r && r.code);
  if (code === 1000) return { ok: false, provider: 'qq', needLogin: true, error: 'QQ 音乐登录态已失效，请重新登录' };
  if (code !== 0) {
    return { ok: false, provider: 'qq', error: 'QQ 返回：' + ((r && (r.msg || r.subcode)) || code || '未知错误') };
  }
  return {
    ok: true, provider: 'qq',
    comment: {
      id: String((r && (r.commentid || r.id)) || 'me_' + Date.now()),
      content: text, likedCount: 0, time: Date.now(), isHot: false, reply: '',
      user: { nickname: login.nickname || '我', avatar: login.avatar || '' },
    },
  };
}

module.exports = {
  setQQCookie, getQQCookie, qqLoginInfo, qqPlaybackAuth,
  handleQQSearch, handleQQSongUrl, handleQQLyric,
  handleQQComments, handleQQPostComment,
};
