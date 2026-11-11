'use strict';

// ====================================================================
//  闻曲 · 听觉年鉴（像素小报的数据层）
//  ------------------------------------------------------------------
//  三种尺度同一套版面：年鉴（近一年）/ 月鉴（本月）/ 周鉴（本周）。
//  记录留一年，所以「年鉴」看得到去年这个时候。
//
//  不统计「你听了多少首」，只找那几个具体的时刻：
//    · 某一天把同一首听了很多遍
//    · 某一首被连跳了很多次
//    · 第一次点红心是什么时候
//  版面规则：标题必须是一件具体的事；数字只出现在撑得住故事的地方。
// ====================================================================

const {
  DAY, timeOf, startOfWeek, startOfMonth, weekIndex, fmtTime, fmtDate, fmtShortDate, fmtYMD,
} = require('./event-time');

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();
const firstArtist = (v) => String(v == null ? '' : v).split(/[\/,、&]/)[0].trim();

const PERIODS = ['year', 'month', 'week'];
const WORDS = {
  year: { span: '近一年', when: '这一年', thisOne: '这一年', issue: '年刊' },
  month: { span: '本月', when: '这个月', thisOne: '这个月', issue: '月号' },
  week: { span: '本周', when: '这一周', thisOne: '这一周', issue: '周鉴' },
};

/** 各尺度的起止 */
function windowOf(period, now) {
  if (period === 'week') return { from: startOfWeek(now), to: now };
  if (period === 'year') return { from: now - 365 * DAY, to: now };
  return { from: startOfMonth(now), to: now };
}

function labelOf(period, from, to, now) {
  if (period === 'week') return `第 ${weekIndex(now)} 周 · ${fmtShortDate(from)} — ${fmtShortDate(to)}`;
  if (period === 'year') return `近一年 · ${fmtYMD(from)} — ${fmtYMD(to)}`;
  return `${new Date(now).getFullYear()} 年 ${new Date(now).getMonth() + 1} 月`;
}

function issueOf(period, now) {
  const d = new Date(now);
  if (period === 'week') return `第 ${weekIndex(now)} 周 · 周鉴`;
  if (period === 'year') return `${d.getFullYear()} 年刊`;
  return `${d.getMonth() + 1} 月号 · 第 ${d.getMonth() + 1} 期`;
}

const isPlay = (e) => ['play', 'complete'].includes(e.type);

function buildYearbook({ events = [], period = 'month', now = Date.now() } = {}) {
  const key = PERIODS.includes(period) ? period : 'month';
  const w = WORDS[key];
  const win = windowOf(key, now);
  const all = (events || []).filter((e) => e && e.song && e.song.name && timeOf(e));

  // 三个尺度各有几条记录：前端据此在标签上标一下，不用点进去才发现是空的
  const available = {};
  for (const p of PERIODS) {
    const range = windowOf(p, now);
    available[p] = all.filter((e) => {
      const ts = timeOf(e);
      return isPlay(e) && ts >= range.from && ts <= range.to;
    }).length;
  }

  const list = all.filter((e) => {
    const ts = timeOf(e);
    return ts >= win.from && ts <= win.to;
  });

  const periodMeta = {
    key,
    label: labelOf(key, win.from, win.to, now),
    issue: issueOf(key, now),
    from: win.from,
    to: win.to,
  };

  const plays = list.filter(isPlay);
  if (!plays.length) {
    // 空态也要指路：这一年有记录、只是这一周没有，就别让人以为应用坏了
    const CN = { year: '年鉴', month: '月鉴', week: '周鉴' };
    const UNIT = { year: '一年', month: '个月', week: '一周' };
    const others = PERIODS.filter((p) => p !== key && available[p] > 0);
    let dek;
    if (!others.length) {
      dek = '近一年还没有播放记录。听一首歌，小报就开始排版了。';
    } else {
      const names = others.map((p) => `${CN[p]}（${available[p]} 条）`).join('、');
      dek = `这${UNIT[key]}还没听歌；${names}里有记录，切过去看看。`;
    }
    return {
      ok: true,
      empty: true,
      period: periodMeta,
      available,
      title: `${w.thisOne}还是白的`,
      dek,
      note: `保留近一年记录 · ${w.span}为空 · 本机生成 · 不出网`,
    };
  }

  const hours = new Array(24).fill(0);
  const songs = new Map();
  const skips = new Map();
  let firstLike = null;

  for (const e of list) {
    const ts = timeOf(e);
    const s = e.song;
    const k = norm(s.name) + '|' + norm(firstArtist(s.artist));
    if (isPlay(e)) {
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
    // 「第一次点红心」取这一期里最早的那条
    if (e.type === 'like' && (!firstLike || ts < firstLike.at)) {
      firstLike = { name: s.name, artist: s.artist || '', at: ts };
    }
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

  // 标题：优先讲一件具体的事，没有具体事就说清这段时间发生了什么
  let title = '', dek = '';
  if (repeatStrong) {
    title = `${fmtDate(repeat.at)}，你把同一首听了 ${repeat.count} 遍`;
    dek = `《${repeat.name}》—— ${fmtTime(repeat.from)} 到 ${fmtTime(repeat.to)}${repeat.count >= 5 ? '，中间几乎没停过。' : '。'}`;
  } else if (skipTop.length && skipTop[0].count >= 3) {
    title = `《${skipTop[0].name}》被你连跳 ${skipTop[0].count} 次`;
    dek = '有些歌不是不好，只是这时候不想听。';
  } else if (firstLike) {
    title = `${fmtDate(firstLike.at)} ${fmtTime(firstLike.at)}，第一次点红心`;
    dek = `给了《${firstLike.name}》。这个时间点，通常不会太清醒。`;
  } else {
    title = `${w.when}，你听了 ${distinct} 首歌`;
    dek = key === 'week'
      ? '这一周还没有哪一首被反复播放——慢慢来。'
      : key === 'year'
        ? '这一年还没有哪一首被反复播放——日子还长。'
        : '这个月还没有哪一首被反复播放——慢慢来。';
  }

  const peakText = peaks.length >= 2
    ? key === 'year'
      ? `这一年里，${peaks[0].h} 点和 ${peaks[1].h} 点是你最常在的两个时段。`
      : `${peaks[0].h} 点和 ${peaks[1].h} 点，是你最常在的两个时段。`
    : peaks.length === 1 ? `你只在 ${peaks[0].h} 点前后听歌。` : '';

  return {
    ok: true,
    empty: false,
    period: periodMeta,
    available,
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
    note: `依据${w.span} ${list.length} 条记录 · 记录保留一年 · 本机生成 · 不出网`,
  };
}

module.exports = { buildYearbook, PERIODS, DAY };
