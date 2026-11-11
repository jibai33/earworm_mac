'use strict';

// ====================================================================
//  闻曲 · 听觉年鉴（像素小报的数据层）
//  ------------------------------------------------------------------
//  不统计「你听了多少首」，只找那几个具体的时刻：
//    · 某一天把同一首听了很多遍
//    · 某一首被连跳了很多次
//    · 第一次点红心是什么时候
//  版面规则：标题必须是一件具体的事；数字只出现在撑得住故事的地方。
// ====================================================================

const DAY = 24 * 60 * 60 * 1000;
const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();
const firstArtist = (v) => String(v == null ? '' : v).split(/[\/,、&]/)[0].trim();
const fmtTime = (ts) => {
  const d = new Date(Number(ts) || 0);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const fmtDate = (ts) => {
  const d = new Date(Number(ts) || 0);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
};

function buildYearbook({ events = [], now = Date.now() } = {}) {
  const list = (events || []).filter((e) => e && e.song && e.song.name);
  const plays = list.filter((e) => ['play', 'complete'].includes(e.type));
  if (!plays.length) {
    return {
      ok: true,
      empty: true,
      title: '这一期还是白的',
      dek: '听几首歌，小报就有东西可写了。',
      note: '记录只存在本机，不出网。',
    };
  }

  const tss = list.map((e) => Number(e.ts) || 0).filter(Boolean);
  const from = Math.min(...tss);
  const to = Math.max(...tss);

  const hours = new Array(24).fill(0);
  const songs = new Map();
  const skips = new Map();
  let firstLike = null;

  for (const e of list) {
    const ts = Number(e.ts) || 0;
    const s = e.song;
    const k = norm(s.name) + '|' + norm(firstArtist(s.artist));
    if (e.type === 'play' || e.type === 'complete') {
      hours[new Date(ts).getHours()] += 1;
      const hit = songs.get(k) || { name: s.name, artist: s.artist || '', count: 0, days: new Map() };
      hit.count += 1;
      const dayKey = new Date(ts).toDateString();
      const day = hit.days.get(dayKey) || { count: 0, first: ts, last: ts };
      day.count += 1;
      day.first = Math.min(day.first, ts);
      day.last = Math.max(day.last, ts);
      hit.days.set(dayKey, day);
      songs.set(k, hit);
    }
    if (e.type === 'skip') {
      const hit = skips.get(k) || { name: s.name, artist: s.artist || '', count: 0 };
      hit.count += 1;
      skips.set(k, hit);
    }
    if (e.type === 'like' && !firstLike) firstLike = { name: s.name, artist: s.artist || '', at: ts };
  }

  // 同一天里重复最多的一首
  let repeat = null;
  for (const hit of songs.values()) {
    for (const [, day] of hit.days) {
      if (!repeat || day.count > repeat.count) {
        repeat = { name: hit.name, artist: hit.artist, count: day.count, at: day.first, from: day.first, to: day.last };
      }
    }
  }
  const repeatStrong = repeat && repeat.count >= 3;

  const skipTop = [...skips.values()].sort((a, b) => b.count - a.count).slice(0, 3).filter((x) => x.count >= 2);
  const peaks = hours
    .map((n, h) => ({ h, n }))
    .sort((a, b) => b.n - a.n)
    .filter((x) => x.n > 0)
    .slice(0, 2)
    .sort((a, b) => a.h - b.h);

  const completeCount = list.filter((e) => e.type === 'complete').length;
  const playCount = plays.length;
  const distinct = songs.size;
  const counts = {
    search: list.filter((e) => e.type === 'search').length,
    skip: list.filter((e) => e.type === 'skip').length,
    like: list.filter((e) => e.type === 'like').length,
    view: list.filter((e) => e.type === 'view').length,
  };

  // 标题：优先讲一件具体的事，没有具体事就说清这个月发生了什么
  let title = '', dek = '';
  if (repeatStrong) {
    title = `${fmtDate(repeat.at)}，你把同一首听了 ${repeat.count} 遍`;
    dek = `《${repeat.name}》—— ${fmtTime(repeat.from)} 到 ${fmtTime(repeat.to)}${repeat.count >= 5 ? '，中间几乎没停过。' : '。'}`;
  } else if (skipTop.length && skipTop[0].count >= 3) {
    title = `《${skipTop[0].name}》被你连跳 ${skipTop[0].count} 次`;
    dek = '有些歌不是不好，只是今天不想听。';
  } else if (firstLike) {
    title = `${fmtDate(firstLike.at)} ${fmtTime(firstLike.at)}，第一次点红心`;
    dek = `给了《${firstLike.name}》。这个时间点，通常不会太清醒。`;
  } else {
    title = `这段时间，你听了 ${distinct} 首歌`;
    dek = '还没有哪一首被反复播放——慢慢来。';
  }

  const peakText = peaks.length >= 2
    ? `你的一天有两个高点：${peaks[0].h} 点和 ${peaks[1].h} 点。`
    : peaks.length === 1 ? `你只在 ${peaks[0].h} 点前后听歌。` : '';

  return {
    ok: true,
    empty: false,
    period: {
      from, to,
      label: new Date(from).toDateString() === new Date(to).toDateString()
        ? fmtDate(from)
        : `${fmtDate(from)} — ${fmtDate(to)}`,
    },
    nums: {
      plays: playCount,
      songs: distinct,
      completeRate: playCount ? Math.round(completeCount / playCount * 100) : 0,
    },
    counts,
    hours,
    peaks,
    peakText,
    skips: skipTop,
    firstLike,
    repeat: repeatStrong ? repeat : null,
    headline: { title, dek },
    note: `依据近 30 天内 ${list.length} 条播放记录 · 本机生成 · 不出网`,
  };
}

module.exports = { buildYearbook, DAY };
