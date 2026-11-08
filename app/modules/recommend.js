// ====================================================================
//  闻曲 · 推荐生成引擎（平台无关）
//  收听 50% / 搜索 30% / 浏览 20% 加权，30 天窗口 + 近 7 天加权。
//  输出：私人电台 / 行为卡 / 猜你会喜欢；冷启动、已关闭状态显式可见。
// ====================================================================
const taste = require('./taste-profile.js');

const DAY = 24 * 60 * 60 * 1000;
const WEIGHTS = { complete: 5, play: 3, like: 6, unlike: -3, skip: -2, search: 2, view: 1 };
const SIGNAL_WEIGHT = { play: 0.5, complete: 0.5, like: 0.5, skip: 0.5, search: 0.3, view: 0.2, unlike: 0.5 };
const GENRE_HINTS = ['民谣', '国风', '古风', '纯音', '轻音乐', '摇滚', '爵士', '电子', '说唱', '古典', '后摇', 'City Pop'];

const text = (v) => String(v == null ? '' : v).trim();
const norm = (v) => text(v).toLowerCase();
const firstArtist = (v) => text(v).split(/[\/,、&]/)[0].trim();

function eventWeight(e, now) {
  const base = WEIGHTS[e.type] || 0;
  const age = now - Number(e.ts || now);
  const decay = age <= 7 * DAY ? 1.6 : age <= 30 * DAY ? 1.0 : 0.4;
  return base * decay;
}
function bump(map, key, delta) {
  const k = norm(key);
  if (!k) return;
  const cur = map.get(k) || { key: text(key), score: 0, count: 0 };
  cur.score += delta; cur.count += 1;
  map.set(k, cur);
}
function topOf(map, n = 5) {
  return [...map.values()].filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, n);
}

/** 把事件流压成一份可解释的听感摘要 */
function analyze(events, now = Date.now()) {
  const list = Array.isArray(events) ? events.filter(e => e && Number(e.ts) >= now - 30 * DAY) : [];
  const artists = new Map(), keywords = new Map(), songs = new Map();
  const counts = { play: 0, complete: 0, skip: 0, search: 0, view: 0, like: 0 };
  const searches = [], views = [], plays = [];
  let night = 0, playEvents = 0, genre = '';

  for (const e of list) {
    const w = eventWeight(e, now);
    const sw = SIGNAL_WEIGHT[e.type] != null ? SIGNAL_WEIGHT[e.type] : 0.2;
    const s = e.song || {};
    if (counts[e.type] != null) counts[e.type] += 1;
    const artist = firstArtist(s.artist);
    const kw = text(e.meta && e.meta.keyword) || text(s.keyword);
    const songKey = norm(s.name) + '|' + norm(artist);

    if (['play', 'complete', 'like', 'skip'].includes(e.type)) {
      playEvents++;
      const h = new Date(Number(e.ts)).getHours();
      if (h >= 22 || h < 6) night++;
      plays.push({ song: s, ts: e.ts, type: e.type });
      bump(artists, artist, w * 0.5);
      if (songKey !== '|') bump(songs, songKey, { score: w, song: s });
    }
    if (e.type === 'search' && kw) {
      searches.push({ keyword: kw, ts: e.ts, provider: s.provider || '' });
      bump(keywords, kw, w * 0.3);
      bump(artists, kw, w * 0.12); // 搜艺人也会形成偏好
    }
    if (e.type === 'view') {
      views.push({ context: text(e.meta && e.meta.context) || text(s.name), song: s, ts: e.ts });
      bump(keywords, text(e.meta && e.meta.context), w * 0.2);
    }
    if (e.type === 'like') bump(artists, artist, w * 0.5);
    // 简单流派倾向：从搜索词与歌单名里命中
    if (!genre) {
      const hay = kw + ' ' + text(e.meta && e.meta.context) + ' ' + text(s.name);
      genre = GENRE_HINTS.find(g => hay.toLowerCase().includes(g.toLowerCase())) || '';
    }
    void sw;
  }

  const topArtists = topOf(artists, 5);
  const topKeywords = topOf(keywords, 5);
  const topSongs = [...songs.values()].filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 12);
  const seen = new Set();
  const recentSearches = searches.sort((a, b) => b.ts - a.ts).filter(x => {
    const k = norm(x.keyword);
    if (seen.has(k)) return false;
    seen.add(k); return true;
  }).slice(0, 8);

  return {
    total: list.length,
    counts,
    topArtists, topKeywords, topSongs,
    recentSearches,
    recentViews: views.sort((a, b) => b.ts - a.ts).slice(0, 6),
    lastPlayed: plays.sort((a, b) => b.ts - a.ts)[0] || null,
    nightRatio: playEvents ? Math.round(night / playEvents * 100) : 0,
    genre: genre || '常听',
    firstTs: list.length ? Math.min(...list.map(e => Number(e.ts))) : 0,
    lastTs: list.length ? Math.max(...list.map(e => Number(e.ts))) : 0,
  };
}

function withTimeout(promise, ms) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);
}
function dedupeSongs(list) {
  const seen = new Set(), out = [];
  for (const s of list) {
    const k = norm(s.name) + '|' + norm(firstArtist(s.artist));
    if (!s || !s.name || seen.has(k)) continue;
    seen.add(k); out.push(s);
  }
  return out;
}

/** 依据 top 艺人与关键词，向曲库取回真实可播的候选曲 */
async function fetchCandidates(searchFn, analysis, limit = 20) {
  if (typeof searchFn !== 'function') return [];
  const queries = [];
  for (const a of analysis.topArtists.slice(0, 3)) queries.push(a.key);
  for (const k of analysis.topKeywords.slice(0, 3)) queries.push(k.key);
  const uniq = [...new Set(queries.map(norm))].slice(0, 4);
  const out = [];
  for (const q of uniq) {
    if (out.length >= limit) break;
    try {
      const songs = await withTimeout(searchFn(q, 10), 4000);
      if (Array.isArray(songs)) out.push(...songs);
    } catch { /* 单个检索失败不影响整体推荐 */ }
  }
  return dedupeSongs(out).slice(0, limit);
}

function reasonFor(song, analysis, index) {
  const artist = firstArtist(song.artist);
  const hitArtist = analysis.topArtists.find(a => norm(a.key) === norm(artist));
  const kw = analysis.recentSearches[0];
  if (kw && norm(kw.keyword) === norm(artist)) return `因你搜过「${kw.keyword}」`;
  if (hitArtist) return `因你常听 ${artist}`;
  if (analysis.nightRatio >= 50 && index % 3 === 0) return '因你深夜常听';
  if (analysis.topSongs.length) return `相似于你常听的《${analysis.topSongs[0].song.name || '那些曲子'}》`;
  return '按你的听感挑选';
}

/**
 * @param {{events:Array, profile:Object, searchFn?:Function, now?:number}} input
 *        profile 为 taste.rawProfile() 的返回值（含 settings / feedback）
 */
async function buildRecommendations({ events, profile, searchFn, now = Date.now(), variant = 0 }) {
  const p = profile || { settings: { enabled: true }, feedback: { songs: {}, artists: {}, keywords: {} } };
  const settings = p.settings || { enabled: true };
  const analysis = analyze(events, now);
  const history = analysis.recentSearches.map(x => x.keyword);
  const base = {
    generatedAt: now,
    updatedAt: p.updatedAt || now,
    syncKey: taste.prettyKey(p.key || ''),
    summary: {
      listen: analysis.counts.play + analysis.counts.complete,
      search: analysis.counts.search,
      view: analysis.counts.view,
      total: analysis.total,
      windowDays: settings.windowDays || 30,
      nightRatio: analysis.nightRatio,
      devices: Object.keys(p.devices || {}).length,
    },
    signals: [],
    history,
    trace: [],
    radio: null,
    cards: [],
    suggestions: [],
    onboarding: null,
  };

  // 已关闭个性化：只给历史与热门入口，不做任何推断
  if (settings.enabled === false) {
    return Object.assign(base, {
      status: 'disabled',
      onboarding: { title: '个性化已关闭', hint: '只显示曾闻与热门，不再记录任何收听行为。', styles: [] },
    });
  }

  // 冷启动：样本不足时明说，不假装懂你
  if (analysis.total < 10) {
    return Object.assign(base, {
      status: 'cold_start',
      onboarding: {
        title: '先听几首，我再懂你',
        hint: `目前只有 ${analysis.total} 条记录，满 10 条后开始生成私人推荐。`,
        styles: ['民谣', '国风', '纯音', '轻音乐', '摇滚', '爵士', '古典', 'City Pop'],
      },
      signals: [{ key: 'cold', label: `记录 ${analysis.total} / 10`, value: '待积累' }],
    });
  }

  const candidates = await fetchCandidates(searchFn, analysis, 24);
  const playable = candidates.filter(s => !taste.isSuppressed(p, s));
  const heard = new Set(analysis.topSongs.map(x => norm(x.song.name) + '|' + norm(firstArtist(x.song.artist))));
  const fresh = playable.filter(s => !heard.has(norm(s.name) + '|' + norm(firstArtist(s.artist))));
  const pool = fresh.length >= 6 ? fresh : playable;
  // 「换一批」：旋转候选顺序，避免同一份推荐反复出现
  const rot = pool.length ? (Math.abs(Number(variant) || 0) * 2) % pool.length : 0;
  const rotated = rot ? [...pool.slice(rot), ...pool.slice(0, rot)] : pool;

  const topA = analysis.topArtists[0];
  const genre = analysis.genre;
  const listenCount = analysis.counts.play + analysis.counts.complete;
  const share = (n) => (analysis.total ? Math.round(n / analysis.total * 100) : 0) + '%';
  base.signals = [
    { key: 'listen', label: `常听 · ${genre}${topA ? ' / ' + topA.key : ''}`, value: share(listenCount), type: 'listen' },
    { key: 'search', label: analysis.recentSearches[0] ? `搜过 · ${analysis.recentSearches[0].keyword}` : '搜索记录', value: share(analysis.counts.search), type: 'search' },
    { key: 'night', label: analysis.nightRatio >= 40 ? `深夜 · 22:00 后循环 ${analysis.nightRatio}%` : '浏览 · 歌单与详情', value: share(analysis.counts.view), type: 'view' },
  ];
  base.trace = [
    topA ? `${topA.key} 近 30 天出现 ${topA.count} 次` : '收听记录正在累积',
    analysis.nightRatio ? `${analysis.nightRatio}% 的播放发生在 22:00 之后` : '暂无明显时段偏好',
    analysis.recentSearches[0] ? `「${analysis.recentSearches[0].keyword}」被搜过 ${analysis.topKeywords.find(k => norm(k.key) === norm(analysis.recentSearches[0].keyword))?.count || 1} 次` : '搜索记录较少',
  ];

  const radioTracks = (rotated.length ? rotated : playable).slice(0, 8);
  base.radio = {
    kicker: 'MIX · 私人墨色电台',
    title: `${genre}夜航 · 给第 ${listenCount + 1} 次循环`,
    reason: topA
      ? `因你反复听 ${topA.key}，混入 ${Math.min(3, radioTracks.length)} 首未曾听过的曲子`
      : '按最近的收听与搜索生成',
    tracks: radioTracks,
    trace: base.trace,
    meta: `${radioTracks.length} 首 · 每小时更新`,
  };

  const last = analysis.lastPlayed;
  if (last && last.song && last.song.name) {
    base.cards.push({
      type: 'continue', kicker: 'CONTINUE · 接着上次听',
      title: last.song.name, desc: `${firstArtist(last.song.artist)} · 上次听到这里`,
      song: last.song, action: '继续播放',
    });
  }
  const sk = analysis.recentSearches[0];
  if (sk) {
    base.cards.push({
      type: 'search', kicker: 'SEARCH · 因你搜过',
      title: sk.keyword, desc: `${analysis.topArtists.length} 位相似艺人 · ${pool.length} 首未听`,
      keyword: sk.keyword, artists: analysis.topArtists.slice(0, 3).map(a => a.key),
      action: '去看看',
    });
  }
  const bv = analysis.recentViews[0];
  if (bv) {
    base.cards.push({
      type: 'browse', kicker: 'BROWSE · 翻过的角落',
      title: bv.context || '最近浏览', desc: '看过但还没听，要不要回访',
      keyword: bv.context, action: '回访这段记录',
    });
  }

  base.suggestions = (rotated.length ? rotated : playable)
    .slice(radioTracks.length, radioTracks.length + 8)
    .map((s, i) => Object.assign({}, s, { reason: reasonFor(s, analysis, i) }));
  if (!base.suggestions.length) {
    base.suggestions = radioTracks.slice(0, 4).map((s, i) => Object.assign({}, s, { reason: reasonFor(s, analysis, i) }));
  }

  return Object.assign(base, { status: 'ready' });
}

module.exports = { analyze, buildRecommendations, WEIGHTS, dedupeSongs };
