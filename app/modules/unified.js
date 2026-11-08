'use strict';
// ====================================================================
//  闻曲 · 统一音源层
//  目标：一次连接，四个平台的音源与信息同时可见、可播，不再手动切平台。
//  Web / macOS / iOS 共用同一组 HTTP JSON 契约（见 /api/unified/*）。
// ====================================================================
const NCM = require('NeteaseCloudMusicApi');
const qqApi = require('./qq-api.js');
const qishuiApi = require('./qishui-api.js');
const xyApi = require('./xiaoyuzhou-api.js');

const PROVIDERS = [
  { id: 'netease', label: '网易云音乐', short: '云村', glyph: '云', login: 'qr',  hint: '用网易云音乐 App 扫一扫' },
  { id: 'qq',      label: 'QQ 音乐',   short: 'QQ',   glyph: 'Q',  login: 'qr',  hint: '手机 QQ / 微信 / QQ 音乐 App 扫码' },
  { id: 'qishui',  label: '汽水音乐', short: '汽水', glyph: '汽', login: 'qr',  hint: '用抖音 App 扫一扫' },
  { id: 'xy',      label: '小宇宙',   short: '小宇宙', glyph: '宙', login: 'sms', hint: '手机号 + 短信验证码' },
];
const META = Object.fromEntries(PROVIDERS.map(p => [p.id, p]));

const SEEDS = ['国风', '华语流行', '纯音乐', '深夜电台', '民谣', '古风', '轻音乐', '城市夜行'];
const DAY_SEED = () => SEEDS[Math.floor(Date.now() / 86400000) % SEEDS.length];

/* ---------- 并发兜底：任一平台慢/挂都不拖垮整页 ---------- */
function withTimeout(task, ms, fallback) {
  return Promise.race([
    Promise.resolve().then(task).catch(e => ({ __error: e && e.message || String(e) })),
    new Promise(resolve => setTimeout(() => resolve({ __error: '请求超时' }), ms)),
  ]).then(v => v === undefined ? fallback : v);
}
const isErr = (v) => !!v && typeof v === 'object' && !!v.__error;

/* ---------- 网易云结构映射（与 server.js 保持一致） ---------- */
function mapArtists(list) { return (list || []).map(a => ({ id: a && a.id, name: a && a.name })); }
function mapSong(s) {
  s = s || {};
  const ar = mapArtists(s.ar || s.artists);
  const al = s.al || s.album || {};
  return {
    provider: 'netease', source: 'netease', type: 'song',
    id: s.id, name: s.name,
    artist: ar.map(a => a.name).join(' / '), artists: ar, artistId: ar[0] && ar[0].id,
    album: al.name || '', albumId: al.id || '',
    cover: al.picUrl || al.coverUrl || '',
    duration: s.dt || s.duration || 0, fee: s.fee,
  };
}
function mapPlaylist(p) {
  p = p || {};
  return {
    provider: 'netease', source: 'netease', type: 'playlist',
    id: p.id, name: p.name, cover: p.coverImgUrl || p.picUrl || '',
    trackCount: p.trackCount || 0, playCount: p.playCount || 0,
    creator: (p.creator || {}).nickname || '', subscribed: !!p.subscribed,
    specialType: p.specialType || 0, tag: (p.tags && p.tags[0]) || '',
  };
}
function normalize(s, provider) {
  s = Object.assign({}, s || {});
  s.provider = s.provider || provider;
  s.source = s.source || s.provider;
  s.type = s.type || (s.isPodcast ? 'podcast' : s.isEpisode ? 'episode' : 'song');
  s.name = s.name || '';
  s.artist = s.artist || '';
  s.cover = s.cover || '';
  s.duration = Number(s.duration) || 0;
  if (s.playable === undefined) s.playable = s.restriction ? false : true;
  return s;
}
const norm = (v) => String(v || '').toLowerCase().replace(/[\s·・（）()『』「」\[\]-]/g, '');
const songKey = (s) => norm(s.name) + '|' + norm(String(s.artist || '').split('/')[0]);

function interleave(groups) {
  const out = [];
  const max = Math.max(0, ...groups.map(g => g.length));
  for (let i = 0; i < max; i++) for (const g of groups) if (g[i]) out.push(g[i]);
  return out;
}

function createUnified(ctx) {
  const neteaseCookie = () => ctx.getNeteaseCookie() || '';
  const qishuiCookie = () => ctx.getQishuiCookie() || '';
  const qqCookie = () => ctx.getQQCookie() || '';

  /* ================= 1. 统一登录态 ================= */
  async function providerStatus(id) {
    const meta = META[id];
    const base = { id, label: meta.label, short: meta.short, glyph: meta.glyph, login: meta.login, hint: meta.hint };
    try {
      if (id === 'netease') {
        const r = await withTimeout(() => NCM.login_status({ cookie: neteaseCookie(), timestamp: Date.now() }), 6000);
        if (isErr(r)) throw new Error(r.__error);
        const b = r.body || {}, profile = b.profile || (b.data && b.data.profile) || {};
        const account = b.account || (b.data && b.data.account) || {};
        return Object.assign(base, {
          loggedIn: !!profile.nickname,
          nickname: profile.nickname || '', avatar: profile.avatarUrl || '',
          userId: account.id || profile.userId || 0,
          detail: profile.nickname ? (Number(b.vipType || 0) === 11 ? 'SVIP' : '已连接') : '',
          capabilities: ['搜索', '每日推荐', '歌单', '歌词', '评论', '播放'],
        });
      }
      if (id === 'qq') {
        const info = qqApi.qqLoginInfo(), auth = qqApi.qqPlaybackAuth();
        return Object.assign(base, {
          loggedIn: !!info.loggedIn, nickname: info.nickname || '', avatar: info.avatar || '',
          userId: info.uin || '',
          detail: info.loggedIn ? (auth.vipReady ? 'VIP 播放已授权' : '已连接 · 待换播放密钥') : '',
          capabilities: info.loggedIn ? ['搜索', '歌词', 'VIP 播放'] : ['搜索', '歌词', '播放（非 VIP）'],
        });
      }
      if (id === 'qishui') {
        const s = await withTimeout(() => qishuiApi.handleQishuiStatus(qishuiCookie()), 7000);
        if (isErr(s)) throw new Error(s.__error);
        return Object.assign(base, {
          loggedIn: !!s.loggedIn, nickname: s.nickname || '', avatar: s.avatar || '',
          userId: s.userId || '', detail: s.loggedIn ? (s.vipLabel || '已连接') : '',
          capabilities: s.loggedIn ? ['搜索', '推荐', '歌单', '歌词', '播放'] : ['公开曲库搜索', '推荐'],
        });
      }
      const s = xyApi.handleXYStatus();
      return Object.assign(base, {
        loggedIn: !!s.loggedIn, nickname: s.nickname || s.phone || '', avatar: s.avatar || '',
        userId: s.uid || '', detail: s.loggedIn ? '已连接' : '',
        capabilities: s.loggedIn ? ['播客搜索', '我的订阅', '单集播放'] : [],
      });
    } catch (e) {
      return Object.assign(base, { loggedIn: false, error: e && e.message || '状态查询失败', capabilities: [] });
    }
  }
  async function status() {
    let options = {};
    try { options = (ctx.getLoginOptions && ctx.getLoginOptions()) || {}; } catch { /* 忽略 */ }
    const list = await Promise.all(PROVIDERS.map(p => providerStatus(p.id)));
    list.forEach(p => {
      const o = options[p.id] || {};
      p.loginReady = o.qr !== false || (o.methods || []).length > 0;
      p.loginMethods = o.methods || [];
      p.loginNote = o.note || '';
      if (o.runtime) p.loginRuntime = o.runtime;
      // 明确告诉用户「扫码为什么用不了」，而不是只显示未登录
      if (!p.loggedIn && !p.loginReady) p.error = p.error || '当前环境没有可用的扫码通道';
    });
    return {
      ok: true, providers: list, loginOptions: options,
      connected: list.filter(x => x.loggedIn).length, total: list.length,
      publicAvailable: list.filter(x => !x.loggedIn && x.capabilities.length).length,
      summary: list.map(x => `${x.short}${x.loggedIn ? '✓' : '·'}`).join('  '),
    };
  }

  /* ================= 2. 单平台检索 ================= */
  async function searchOne(id, keyword, limit, offset) {
    const meta = META[id];
    const out = { id, short: meta.short, label: meta.label, count: 0, status: 'ok', message: '' };
    let r;
    try {
      if (id === 'netease') {
        r = await withTimeout(() => NCM.cloudsearch({ keywords: keyword, limit: Math.min(30, limit), offset, cookie: neteaseCookie() }), 9000);
        if (isErr(r)) throw new Error(r.__error);
        out.songs = ((r.body.result && r.body.result.songs) || []).map(mapSong);
      } else if (id === 'qq') {
        r = await withTimeout(() => qqApi.handleQQSearch(keyword, Math.min(30, limit), offset), 9000);
        if (isErr(r)) throw new Error(r.__error);
        out.songs = r.songs || [];
      } else if (id === 'qishui') {
        r = await withTimeout(() => qishuiApi.handleQishuiSearch(keyword, Math.min(18, limit), qishuiCookie(), offset), 10000);
        if (isErr(r)) throw new Error(r.__error);
        out.songs = r.songs || [];
        if (!r.loggedIn && !r.webSession) out.status = 'public';
      } else {
        r = await withTimeout(() => xyApi.handleXYSearch(keyword, 20, offset), 9000);
        if (isErr(r)) throw new Error(r.__error);
        out.songs = r.songs || [];
      }
      if (out.songs.length === 0 && r && (r.error || r.message)) {
        out.status = r.error === 'NEED_LOGIN' ? 'need_login' : 'empty';
        out.message = r.message || r.error || '';
      }
    } catch (e) {
      out.songs = []; out.status = 'error'; out.message = e && e.message || '检索失败';
    }
    out.songs = (out.songs || []).map(s => normalize(s, id));
    out.count = out.songs.length;
    if (out.status === 'ok' && out.count) out.message = `${out.count} 条`;
    return out;
  }

  /* ================= 3. 全域搜索：一次请求覆盖全部音源 ================= */
  async function search(keyword, limit, page) {
    keyword = String(keyword || '').trim();
    if (!keyword) return { ok: true, keyword, songs: [], sources: [], page: 0, hasMore: false };
    const per = Math.max(4, Math.min(18, Number(limit) || 12));
    const p = Math.max(0, Math.min(10, Number(page) || 0));
    const results = await Promise.all(PROVIDERS.map(x => searchOne(x.id, keyword, per, p * per)));
    const groups = results.map(r => r.songs || []);
    const songs = interleave(groups);
    // 同名曲目标注「其它平台也有」，让用户知道可换源
    const byKey = new Map();
    songs.forEach(s => {
      const k = songKey(s);
      if (!k || k === '|') return;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(s.provider);
    });
    songs.forEach(s => {
      const others = (byKey.get(songKey(s)) || []).filter(x => x !== s.provider);
      if (others.length) s.alsoOn = [...new Set(others)];
    });
    const sources = results.map(r => ({
      id: r.id, short: r.short, label: r.label, count: r.count,
      status: r.status, message: r.message,
    }));
    return {
      ok: true, keyword, page: p, songs, sources,
      total: songs.length,
      hasMore: results.some(r => r.count >= (r.id === 'qishui' ? Math.min(18, per) : per)),
      connected: sources.filter(s => s.status !== 'need_login').length,
    };
  }

  /* ================= 4. 统一首页：每个平台一个栏目 ================= */
  async function neteaseHome(seed) {
    let daily = [];
    try {
      const r = await withTimeout(() => NCM.recommend_songs({ cookie: neteaseCookie(), timestamp: Date.now() }), 8000);
      if (!isErr(r)) daily = ((r.body.data && r.body.data.dailySongs) || []).map(mapSong);
    } catch { /* 降级 */ }
    if (!daily.length) {
      try {
        const r = await withTimeout(() => NCM.personalized_newsong({ limit: 20, cookie: neteaseCookie(), timestamp: Date.now() }), 8000);
        if (!isErr(r)) daily = (r.body.data || []).map(mapSong);
      } catch { /* 空 */ }
    }
    let pls = [];
    try {
      const r = await withTimeout(() => NCM.personalized({ limit: 8, cookie: neteaseCookie(), timestamp: Date.now() }), 8000);
      if (!isErr(r)) pls = (r.body.result || []).map(mapPlaylist);
    } catch { /* 空 */ }
    return { daily, pls };
  }
  async function home() {
    const seed = DAY_SEED();
    const [st, ne, qq, qs, xy] = await Promise.all([
      status(),
      withTimeout(() => neteaseHome(seed), 9000),
      withTimeout(() => qqApi.handleQQSearch(seed, 12, 0), 9000),
      withTimeout(() => qishuiApi.handleQishuiFeed(12, qishuiCookie()), 10000),
      withTimeout(() => xyApi.handleXYSubscription(24), 8000),
    ]);
    const neData = isErr(ne) ? { daily: [], pls: [] } : (ne || { daily: [], pls: [] });
    const sections = [];

    sections.push({
      id: 'netease-daily', provider: 'netease', short: '云村', label: '网易云音乐',
      title: '今日推荐', subtitle: '每日为你读谱', kind: 'song',
      status: neData.daily.length ? 'ok' : 'empty',
      items: (neData.daily || []).slice(0, 20).map(s => normalize(s, 'netease')),
    });
    sections.push({
      id: 'netease-playlists', provider: 'netease', short: '云村', label: '网易云音乐',
      title: '拾遗歌单', subtitle: '按你的口味挑的曲单', kind: 'playlist',
      status: neData.pls.length ? 'ok' : 'empty',
      items: (neData.pls || []).slice(0, 8),
    });
    const qqSongs = isErr(qq) ? [] : ((qq && qq.songs) || []);
    sections.push({
      id: 'qq-hot', provider: 'qq', short: 'QQ', label: 'QQ 音乐',
      title: `QQ 音乐 · ${seed}`, subtitle: '跨平台同曲，直接点播', kind: 'song',
      status: qqSongs.length ? 'ok' : (isErr(qq) ? 'error' : 'empty'),
      message: isErr(qq) ? qq.__error : '',
      items: qqSongs.slice(0, 14).map(s => normalize(s, 'qq')),
    });
    let qsSongs = [];
    let qsNote = '';
    if (!isErr(qs) && qs && qs.songs && qs.songs.length) qsSongs = qs.songs;
    else {
      const fb = await withTimeout(() => qishuiApi.handleQishuiSearch(seed, 12, qishuiCookie(), 0), 9000);
      if (!isErr(fb)) qsSongs = (fb && fb.songs) || [];
      qsNote = '未登录，展示公开曲库';
    }
    sections.push({
      id: 'qishui-feed', provider: 'qishui', short: '汽水', label: '汽水音乐',
      title: '汽水流光', subtitle: qsNote || '来自汽水的推荐', kind: 'song',
      status: qsSongs.length ? 'ok' : 'empty', message: qsNote,
      items: qsSongs.slice(0, 14).map(s => normalize(s, 'qishui')),
    });
    const xyPods = isErr(xy) ? [] : ((xy && xy.podcasts) || []);
    const xyLoggedIn = st.providers.find(x => x.id === 'xy').loggedIn;
    sections.push({
      id: 'xy-sub', provider: 'xy', short: '小宇宙', label: '小宇宙',
      title: '我的订阅', subtitle: xyLoggedIn ? '订阅的播客与节目' : '连接小宇宙后显示订阅', kind: 'podcast',
      status: !xyLoggedIn ? 'need_login' : (xyPods.length ? 'ok' : 'empty'),
      message: !xyLoggedIn ? '手机号 + 短信验证码登录后可看订阅与播客' : '',
      action: !xyLoggedIn ? { label: '连接小宇宙', tab: 'xy' } : null,
      items: xyPods.slice(0, 14).map(s => normalize(s, 'xy')),
    });

    const feed = interleave(sections.filter(s => s.kind === 'song').map(s => s.items));
    return { ok: true, seed, generatedAt: Date.now(), sections, feed, status: st };
  }

  /* ================= 5. 统一曲库：所有平台的歌单 / 订阅 ================= */
  async function library() {
    const [st, ne, qs, xy] = await Promise.all([
      status(),
      (async () => {
        const neSt = await providerStatus('netease');
        if (!neSt.loggedIn || !neSt.userId) return { items: [], status: 'need_login', message: '扫码登录后同步云村歌单' };
        try {
          const r = await withTimeout(() => NCM.user_playlist({ uid: neSt.userId, limit: 60, cookie: neteaseCookie(), timestamp: Date.now() }), 8000);
          if (isErr(r)) throw new Error(r.__error);
          return { items: (r.body.playlist || []).map(mapPlaylist), status: 'ok' };
        } catch (e) { return { items: [], status: 'error', message: e.message }; }
      })(),
      withTimeout(() => qishuiApi.handleQishuiUserPlaylists(qishuiCookie()), 10000),
      withTimeout(() => xyApi.handleXYSubscription(100), 8000),
    ]);
    const groups = [];
    groups.push({
      provider: 'netease', short: '云村', label: '网易云音乐 · 我的歌单',
      status: ne.status, message: ne.message || '',
      action: ne.status === 'need_login' ? { label: '扫码连接', tab: 'netease' } : null,
      items: (ne.items || []).map(p => Object.assign({ type: 'playlist' }, p)),
    });
    const qsData = isErr(qs) ? {} : (qs || {});
    groups.push({
      provider: 'qishui', short: '汽水', label: '汽水音乐 · 歌单 / 喜欢',
      status: (qsData.playlists || []).length ? (qsData.loggedIn ? 'ok' : 'public') : 'need_login',
      message: qsData.loggedIn ? '' : '抖音 App 扫码后可同步我的喜欢与歌单',
      action: qsData.loggedIn ? null : { label: '扫码连接', tab: 'qishui' },
      items: (qsData.playlists || []).map(p => normalize(Object.assign({ type: 'playlist' }, p), 'qishui')),
    });
    groups.push({
      provider: 'qq', short: 'QQ', label: 'QQ 音乐 · 曲库',
      status: 'info', message: 'QQ 音乐按曲目检索，登录后解锁 VIP / 无损播放',
      action: { label: '扫码连接', tab: 'qq' },
      items: [],
    });
    const xyData = isErr(xy) ? {} : (xy || {});
    groups.push({
      provider: 'xy', short: '小宇宙', label: '小宇宙 · 我的订阅',
      status: xyData.loggedIn ? ((xyData.podcasts || []).length ? 'ok' : 'empty') : 'need_login',
      message: xyData.loggedIn ? '' : '手机号 + 短信验证码登录后可看订阅',
      action: xyData.loggedIn ? null : { label: '去登录', tab: 'xy' },
      items: (xyData.podcasts || []).map(p => normalize(Object.assign({ type: 'podcast' }, p), 'xy')),
    });
    return { ok: true, groups, status: st, total: groups.reduce((n, g) => n + g.items.length, 0) };
  }

  /* ================= 6. 统一歌单详情 ================= */
  async function playlist(provider, id) {
    if (provider === 'netease') {
      const [metaR, r] = await Promise.all([
        withTimeout(() => NCM.playlist_detail({ id, cookie: neteaseCookie(), timestamp: Date.now() }), 8000),
        withTimeout(() => NCM.playlist_track_all({ id, limit: 50, cookie: neteaseCookie(), timestamp: Date.now() }), 9000),
      ]);
      const meta = !isErr(metaR) && metaR.body && metaR.body.playlist ? mapPlaylist(metaR.body.playlist) : { id, name: '曲单' };
      return { ok: true, provider, playlist: meta, tracks: isErr(r) ? [] : ((r.body && r.body.songs) || []).map(mapSong) };
    }
    if (provider === 'qishui') {
      const r = await withTimeout(() => qishuiApi.handleQishuiPlaylistTracks(id, { limit: 50 }, qishuiCookie()), 10000);
      if (isErr(r)) return { ok: false, provider, error: r.__error, tracks: [] };
      return { ok: true, provider, playlist: r.playlist || { id, name: '汽水曲单' }, tracks: (r.tracks || []).map(s => normalize(s, 'qishui')) };
    }
    if (provider === 'xy') {
      const r = await withTimeout(() => xyApi.handleXYPodcast(id), 9000);
      if (isErr(r)) return { ok: false, provider, error: r.__error, tracks: [] };
      return { ok: true, provider, playlist: r.podcast || { id, name: '播客' }, tracks: (r.episodes || []).map(s => normalize(s, 'xy')) };
    }
    return { ok: false, error: '不支持的平台：' + provider, tracks: [] };
  }

  /* ================= 7. 播放失败自动换源 ================= */
  // 某平台取不到地址（VIP / 版权 / 未登录）时，在其余平台找同一首歌的可播版本。
  async function alternatives(name, artist, exclude) {
    name = String(name || '').trim();
    if (!name) return { ok: true, candidates: [] };
    const kw = artist ? `${name} ${String(artist).split('/')[0].trim()}` : name;
    const ids = PROVIDERS.filter(x => x.id !== exclude);
    const results = await Promise.all(ids.map(x => searchOne(x.id, kw, 8, 0)));
    const targetName = norm(name), targetArtist = norm(String(artist || '').split('/')[0]);
    const candidates = [];
    results.forEach((r, i) => {
      (r.songs || []).forEach(s => {
        if (s.isPodcast || s.type === 'podcast' || s.type === 'episode') return;
        const n = norm(s.name), a = norm(String(s.artist || '').split('/')[0]);
        const nameOk = n === targetName || n.includes(targetName) || targetName.includes(n);
        const artistOk = !targetArtist || a.includes(targetArtist) || targetArtist.includes(a);
        if (!nameOk || !artistOk) return;
        if (s.restriction || s.playable === false) return;
        candidates.push(Object.assign(normalize(s, ids[i].id), {
          score: (n === targetName ? 2 : 0) + (a === targetArtist ? 1 : 0) + (s.fee === 0 ? 1 : 0),
        }));
      });
    });
    candidates.sort((a, b) => b.score - a.score);
    // 每个平台只留最佳一条，优先给不重复的音源
    const seen = new Set();
    const picked = [];
    candidates.forEach(c => { if (!seen.has(c.provider)) { seen.add(c.provider); picked.push(c); } });
    return { ok: true, keyword: kw, candidates: picked.slice(0, 5) };
  }

  return { PROVIDERS, META, status, search, home, library, playlist, alternatives, searchOne };
}

module.exports = { createUnified, PROVIDERS, META };
