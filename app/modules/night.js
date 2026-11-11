// ====================================================================
//  闻曲 · 深夜频道（平台无关）
//  0–5 点只放慢的：不推热歌、不猜心情，按「慢」而不是「火」取曲。
//  另附「给我一首意外的」——从画像里权重最低的流派抽，且近期没播过。
//  纯函数 + 注入 searchFn，Web / macOS / iOS 共用同一份契约。
// ====================================================================

const DAY = 24 * 60 * 60 * 1000;

// 命中即认为「适合深夜」
const SLOW_HINTS = [
  '纯音乐', '纯音', '钢琴', '吉他', '器乐', '轻音乐', '轻电子', 'ambient', 'lofi', 'lo-fi',
  '慢', '抒情', '安静', '温柔', '治愈', '助眠', '睡眠', '雨', '夜', '晚风', '月光',
  '民谣', '古典', '爵士', '后摇', 'dream pop', '夜曲', '摇篮',
];
// 命中即排除（再慢的场合也不放这些）
const LOUD_HINTS = [
  '摇滚', 'punk', '朋克', '金属', 'metal', '硬核', '电子', '舞曲', 'remix', 'edm',
  '说唱', 'rap', 'dj', '抖音', '蹦迪', '嗨', '炸', '燃', 'game', 'phonk',
];
// 冷启动或画像太薄时的取曲方向（刻意避开热歌榜）
const SLOW_KEYWORDS = ['夜的钢琴曲', '纯音乐 助眠', 'lofi 放松', '雨声 白噪音', '慢民谣', '爵士 深夜'];
const TAIL_GENRES = ['冷门民谣', '器乐后摇', 'bossa nova', 'city pop 慢歌', '老爵士', '钢琴改编'];

// 不是音乐的东西：深夜频道只放曲子，ASMR / 有声书一律不要
const OFF_TOPIC = ['asmr', '采耳', '有声书', '有声', '相声', '评书', '广播剧', '故事', '课程', '讲座', '播客'];

const text = (v) => String(v == null ? '' : v).trim();
const norm = (v) => text(v).toLowerCase();
const firstArtist = (v) => text(v).split(/[\/,、&]/)[0].trim();
const songKey = (s) => norm((s && s.name) || '') + '|' + norm(firstArtist(s && s.artist));

function hayOf(song) {
  const s = song || {};
  return norm([s.name, s.artist, s.album].filter(Boolean).join(' '));
}
function isSlow(song) {
  const hay = hayOf(song);
  if (!hay) return false;
  if (LOUD_HINTS.some((w) => hay.includes(w))) return false;
  if (OFF_TOPIC.some((w) => hay.includes(w))) return false;
  return SLOW_HINTS.some((w) => hay.includes(w));
}
function isQuiet(song) {
  const hay = hayOf(song);
  if (!hay) return false;
  if (LOUD_HINTS.some((w) => hay.includes(w))) return false;
  return !OFF_TOPIC.some((w) => hay.includes(w));
}

function withTimeout(promise, ms) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);
}
function dedupe(list) {
  const seen = new Set(), out = [];
  for (const s of list) {
    const k = songKey(s);
    if (!s || !s.name || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

function playedSet(events) {
  const set = new Set();
  for (const e of events || []) if (e && e.song) set.add(songKey(e.song));
  return set;
}

/**
 * 深夜曲单：慢 + 未播过优先 + 各方向都取一点，避免一屏全是同一种钢琴曲
 * @param {{events:Array, profile:Object, searchFn:Function, now?:number, limit?:number}} input
 */
async function buildNight({ events = [], searchFn, isSuppressed, now = Date.now(), limit = 12 } = {}) {
  const heard = playedSet(events);
  const candidates = [];

  for (const kw of SLOW_KEYWORDS) {
    if (typeof searchFn !== 'function') break;
    try {
      const songs = await withTimeout(searchFn(kw, 8), 5000);
      if (Array.isArray(songs)) candidates.push(...songs.map((s) => Object.assign({}, s, { _kw: kw })));
    } catch { /* 单个方向失败不影响整条频道 */ }
  }

  const usable = dedupe(candidates).filter((s) => (typeof isSuppressed === 'function' ? !isSuppressed(s) : true));
  let pool = usable.filter((s) => isSlow(s));
  if (pool.length < 6) {
    // 慢曲不够时放宽到「不吵就行」，宁可不那么准，也不给一张空列表
    pool = usable.filter(isQuiet);
  }
  const fresh = pool.filter((s) => !heard.has(songKey(s)));
  const ordered = [...fresh, ...pool.filter((s) => heard.has(songKey(s)))];

  // 每个检索方向最多留 2 首，保证「钢琴 / 雨声 / 爵士」混着来
  const perKw = new Map();
  const tracks = [];
  for (const s of ordered) {
    const n = perKw.get(s._kw) || 0;
    if (n >= 2) continue;
    perKw.set(s._kw, n + 1);
    tracks.push(s);
    if (tracks.length >= limit) break;
  }
  if (tracks.length < limit) {
    for (const s of ordered) {
      if (tracks.includes(s)) continue;
      tracks.push(s);
      if (tracks.length >= limit) break;
    }
  }

  const hour = new Date(now).getHours();
  return {
    ok: true,
    hour,
    isNight: hour >= 0 && hour < 5,
    window: '00:00 — 05:00',
    note: '这个点你也醒着 —— 不推热歌，不猜心情。',
    lyric: '「晚安，是留给还醒着的人的暗号」',
    explain: {
      rule: '只取「慢」：命中钢琴 / 器乐 / 民谣 / 爵士 / 雨声等标签，排除摇滚与电子',
      source: '网易云曲库检索 · 本机画像只用来决定「先给你哪几首」',
      heardCount: heard.size,
    },
    tracks,
  };
}

// isSlow 里已包含 loud 检查，放宽分支只需要「不吵」

/** 关键词权重：搜索词与曲目标签都算，只统计出现过的事实 */
function keywordCounts(events) {
  const map = new Map();
  for (const e of events || []) {
    const kw = text(e && e.meta && e.meta.keyword) || text(e && e.song && e.song.keyword);
    if (!kw) continue;
    map.set(kw, (map.get(kw) || 0) + 1);
  }
  return map;
}

/**
 * 「给我一首意外的」：从权重最低的方向抽一首，且近期没播过。
 * 这是真的绕过画像，不是随机打乱当前队列。
 */
async function surprise({ events = [], searchFn, now = Date.now() } = {}) {
  const heard = playedSet(events.filter((e) => ['play', 'complete', 'like'].includes(e.type)));
  const counts = keywordCounts(events);
  const ranked = [...counts.entries()].sort((a, b) => a[1] - b[1]).map(([k]) => k);
  const coldPool = TAIL_GENRES.slice().sort(() => Math.random() - .5);
  const directions = [...ranked.slice(0, 4), ...coldPool].slice(0, 7);

  for (const kw of directions) {
    if (typeof searchFn !== 'function') break;
    let songs = [];
    try { songs = await withTimeout(searchFn(kw, 8), 5000); } catch { continue; }
    if (!Array.isArray(songs) || !songs.length) continue;
    // 深夜频道里「意外」也不该是炸场：先挑不吵的，实在没有才放宽
    const unheard = songs.filter((s) => !heard.has(songKey(s)));
    const quiet = unheard.filter(isQuiet);
    const pick = (quiet.length ? quiet : unheard).slice(0, 3);
    if (!pick.length) continue;
    const song = pick[Math.floor(Math.random() * pick.length)];
    return {
      ok: true,
      keyword: kw,
      song,
      alternatives: pick,
      reason: counts.has(kw)
        ? `你最少搜「${kw}」（${counts.get(kw)} 次）· 近 30 天没播过`
        : `画像里没有的方向「${kw}」· 近 30 天没播过`,
      days: 30,
    };
  }
  return { ok: false, error: '没抽到合适的曲子，换个时间再试' };
}

module.exports = {
  SLOW_HINTS, LOUD_HINTS, SLOW_KEYWORDS, TAIL_GENRES,
  isSlow, buildNight, surprise, keywordCounts, songKey,
};
