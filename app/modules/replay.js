'use strict';

// ====================================================================
//  闻曲 · 回听数据层（v2）
//  ------------------------------------------------------------------
//  设计定稿里最要紧的一件事：把攒下来的「只读展柜」重新变成播放队列。
//  这里只做平台无关的事件流运算，不碰曲库、不碰播放：
//    · buildReplay  按真实播放顺序取出一段时间听过的歌（墙 / 年鉴 / 去年今天）
//    · buildHeat    最近 30 天的像素热度条
//    · buildLastYear 去年今天的几张封面
//    · pickDaily    每天只出一首「今日一曲」（从画像方向检索，近 30 天没播过）
//  所有时间一律用 event-time.timeOf（真实发生时间），避免离线补报把旧歌算进今天。
// ====================================================================

const { DAY, timeOf, startOfDay, startOfWeek, startOfMonth, dayKeyOf, parseDayKey } = require('./event-time');

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();
const firstArtist = (v) => String(v == null ? '' : v).split(/[\/,、&]/)[0].trim();
const songKey = (s) => norm(s && s.name) + '|' + norm(firstArtist(s && s.artist));
const PLAY_TYPES = ['play', 'complete'];

/** 各尺度的起止，与 yearbook.js 保持同一口径 */
function windowOf(period, now) {
  if (period === 'week') return { from: startOfWeek(now), to: now };
  if (period === 'year') return { from: now - 365 * DAY, to: now };
  return { from: startOfMonth(now), to: now };
}

function rangeOf({ scope = 'day', day, period = 'month', offset = -1, now = Date.now() }) {
  if (scope === 'day') {
    const p = parseDayKey(day);
    const from = p == null ? startOfDay(now) : p;
    return { from, to: from + DAY, label: dayKeyOf(from) };
  }
  if (scope === 'period') {
    const w = windowOf(period, now);
    const CN = { year: '年刊', month: '月鉴', week: '周鉴' };
    return { from: w.from, to: w.to, label: CN[period] || '这一期' };
  }
  if (scope === 'lastyear') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    // 2/29 → 去年 2/28：setFullYear 后日期可能被推到 3/1，反向校验一次
    const month = d.getMonth(), date = d.getDate();
    d.setFullYear(d.getFullYear() + Number(offset || -1));
    if (d.getMonth() !== month) d.setDate(0);
    if (d.getDate() !== date && month === 1) d.setDate(0);
    const from = startOfDay(d.getTime());
    return { from, to: from + DAY, label: `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}` };
  }
  const from = startOfDay(now);
  return { from, to: from + DAY, label: dayKeyOf(from) };
}

/**
 * 把一段时间里真实播过的歌，按发生顺序变成一条可播队列。
 * 同一首只进一次，重复次数记在 plays 上（前端队列角标显示 ×N）。
 * @param {{events:Array, scope?:string, day?:string, period?:string,
 *          offset?:number, source?:string, limit?:number, now?:number}} input
 */
function buildReplay({ events = [], scope = 'day', day, period = 'month', offset = -1,
  source, limit = 60, now = Date.now() } = {}) {
  const r = rangeOf({ scope, day, period, offset, now });
  const cap = Math.max(1, Math.min(120, Number(limit) || 60));
  const picked = [];
  for (const e of events || []) {
    if (!e || !PLAY_TYPES.includes(e.type)) continue;
    const s = e.song || {};
    if (!s.name) continue;
    const ts = timeOf(e);
    if (!ts || ts < r.from || ts >= r.to) continue;
    picked.push({ song: s, ts });
  }
  picked.sort((a, b) => a.ts - b.ts);

  const map = new Map();
  for (const { song, ts } of picked) {
    const k = songKey(song);
    const hit = map.get(k);
    if (hit) {
      hit.plays += 1;
      hit.last = ts;
      if (!hit.cover && song.cover) hit.cover = song.cover;
      continue;
    }
    map.set(k, {
      id: String(song.id || ''),
      provider: String(song.provider || 'netease'),
      name: String(song.name || ''),
      artist: String(song.artist || ''),
      cover: String(song.cover || ''),
      plays: 1,
      first: ts,
      last: ts,
      ewSource: source || r.label,
    });
  }
  const all = [...map.values()];
  const tracks = all.slice(0, cap).map((t) => {
    const o = Object.assign({}, t);
    delete o.first;
    return o;
  });
  return {
    ok: true,
    empty: tracks.length === 0,
    scope,
    label: r.label,
    from: r.from,
    to: r.to,
    count: all.length,
    tracks,
    hasMore: all.length > cap,
    note: '按当天真实播放顺序 · 同曲只进一次 · 取不到地址自动跳下一首',
  };
}

/** 最近 30 天热度：每天一个小方块，level 0/1/2/3 = 无 / 少 / 中 / 多 */
function buildHeat({ events = [], days = 30, now = Date.now() } = {}) {
  const n = Math.max(7, Math.min(90, Number(days) || 30));
  const today = startOfDay(now);
  const from = today - (n - 1) * DAY;
  const counts = new Map();
  for (const e of events || []) {
    if (!e || !PLAY_TYPES.includes(e.type)) continue;
    const ts = timeOf(e);
    if (!ts || ts < from || ts >= today + DAY) continue;
    const k = dayKeyOf(ts);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const list = [];
  for (let i = 0; i < n; i++) {
    const ts = from + i * DAY;
    const key = dayKeyOf(ts);
    const count = counts.get(key) || 0;
    list.push({
      day: key,
      count,
      level: count === 0 ? 0 : count <= 2 ? 1 : count <= 7 ? 2 : 3,
      isToday: key === dayKeyOf(now),
    });
  }
  return { ok: true, days: n, from, to: today + DAY, list, total: [...counts.values()].reduce((a, b) => a + b, 0) };
}

/** 去年今天：几张封面 + 一句具体的话，无数据就明确告诉首页别显示这张卡 */
function buildLastYear({ events = [], offset = -1, now = Date.now(), limit = 6 } = {}) {
  const r = rangeOf({ scope: 'lastyear', offset, now });
  const data = buildReplay({ events, scope: 'lastyear', offset, now, limit, source: '去年今天' });
  const covers = data.tracks.slice(0, 4);
  const total = data.tracks.reduce((n, t) => n + (t.plays || 1), 0);
  return {
    ok: true,
    empty: data.empty,
    label: r.label,
    from: r.from,
    to: r.to,
    count: data.count,
    covers,
    line: data.empty ? '' : total >= 8
      ? `那天你把这 ${covers.length} 首循环了一整晚`
      : `那天你听过这 ${covers.length} 首`,
  };
}

/* ---------------- 今日一曲 ---------------- */

// 文案是固定句子，按日期取，不做生成式文案：保持「纯本机、老机器」的气质
const DAILY_LINES = [
  '这张唱片，最近 30 天没上过机。',
  '今天只挑一首，听完再决定要不要继续。',
  '从你常听的方向，往旁边挪一小步。',
  '一首没被算法反复递到手边的歌。',
  '老规矩：一天一张，播过盖章。',
  '不用挑，今天这首已经替你选好了。',
  '有些歌要留到今天才对味。',
];
const COLD_QUERIES = ['深夜 民谣', '钢琴 轻音乐', '城市 夜晚 慢歌', '老歌 翻唱', '爵士 深夜'];

function dayHash(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h;
}

function withTimeout(promise, ms) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);
}

function directionsOf(events, now) {
  const artists = new Map(), kws = new Map();
  for (const e of events || []) {
    if (!e || !PLAY_TYPES.includes(e.type)) continue;
    const ts = timeOf(e);
    if (!ts || ts < now - 30 * DAY) continue;
    const s = e.song || {};
    const a = firstArtist(s.artist);
    if (a) artists.set(a, (artists.get(a) || 0) + 1);
    const kw = String((e.meta && e.meta.keyword) || s.keyword || '').trim();
    if (kw) kws.set(kw, (kws.get(kw) || 0) + 1);
  }
  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
  return {
    artists: top(artists, 2),
    keywords: top(kws, 2),
    queries: [...top(artists, 2), ...top(kws, 2)],
  };
}

/**
 * 今日一曲：当天固定，从画像方向检索，排除近 30 天播过的。
 * 「已听」不落库——直接看当天事件流，盖章只是把事实显示出来。
 * @param {{events:Array, searchFn?:Function, now?:number}} input
 */
async function pickDaily({ events = [], searchFn, now = Date.now() } = {}) {
  const day = dayKeyOf(now);
  const hash = dayHash(day);
  const history = [];
  for (const e of events || []) {
    if (!e || !PLAY_TYPES.includes(e.type) || !e.song || !e.song.name) continue;
    const ts = timeOf(e);
    if (!ts) continue;
    history.push({ song: e.song, ts });
  }
  // 近 30 天没播过：只用近 30 天的事件构成排除集，别把一年前的老歌也排除掉
  const recent = new Set();
  for (const e of events || []) {
    if (!e || !PLAY_TYPES.includes(e.type) || !e.song || !e.song.name) continue;
    const ts = timeOf(e);
    if (ts && ts >= now - 30 * DAY && ts <= now) recent.add(songKey(e.song));
  }

  const dir = directionsOf(events, now);
  const queries = [...dir.queries, ...COLD_QUERIES].slice(0, 4);
  const candidates = [];
  if (typeof searchFn === 'function') {
    // 并行取方向：断网时也只等一轮（3.5s），不要让用户对着空卡等五次超时
    const batch = await Promise.all(queries.map(async (kw) => {
      try {
        const songs = await withTimeout(searchFn(kw, 10), 3500);
        return Array.isArray(songs) ? songs.map((s) => Object.assign({}, s, { _kw: kw })) : [];
      } catch { return []; }
    }));
    for (const group of batch) candidates.push(...group);
  }
  const seen = new Set();
  const pool = [];
  for (const s of candidates) {
    if (!s || !s.name) continue;
    const k = songKey(s);
    if (seen.has(k) || recent.has(k)) continue;
    seen.add(k);
    pool.push(s);
  }
  // 曲库检索全挂了也不留空卡：从一年内的老记录里挑一首近 30 天没听的
  if (!pool.length) {
    const old = history
      .filter(({ song, ts }) => song && song.name && ts < now - 30 * DAY && !recent.has(songKey(song)))
      .map(({ song }) => song);
    const uniq = new Map();
    for (const s of old) if (!uniq.has(songKey(s))) uniq.set(songKey(s), s);
    pool.push(...uniq.values());
  }
  if (!pool.length) {
    return {
      ok: true, empty: true, day,
      reason: '还没有足够的收听记录',
      line: '今天先挂上第一张',
      note: '去听一首，明天这里就会有属于你的一曲。',
    };
  }

  const song = pool[hash % pool.length];
  const fromArtist = dir.artists.some((a) => norm(a) && norm(song.artist).includes(norm(a)));
  const reason = fromArtist
    ? `从你常听的「${firstArtist(song.artist)}」里，挑了首近 30 天没播过的`
    : song._kw
      ? `从「${song._kw}」这个方向挑的 · 近 30 天没播过`
      : '从这一年的记录里，挑了首近 30 天没播过的';
  const clean = Object.assign({}, song);
  delete clean._kw;

  // 盖章：当天真的播过这首就算已听
  const todayFrom = startOfDay(now);
  const heardToday = (events || []).some((e) => {
    if (!e || !PLAY_TYPES.includes(e.type)) return false;
    const ts = timeOf(e);
    return ts >= todayFrom && ts < todayFrom + DAY && songKey(e.song) === songKey(clean);
  });

  return {
    ok: true,
    empty: false,
    day,
    song: clean,
    reason,
    line: DAILY_LINES[hash % DAILY_LINES.length],
    heard: heardToday,
    note: '每天 00:00 换一张 · 播过盖章 · 只读本机记录',
  };
}

module.exports = {
  buildReplay, buildHeat, buildLastYear, pickDaily,
  windowOf, songKey, dayHash, DAILY_LINES,
};
