'use strict';

// ====================================================================
//  闻曲 · 像素唱片墙
//  ------------------------------------------------------------------
//  一天一面墙。当天听过的封面钉在当天的墙上，退出再进来还是同一面；
//  日期翻回去能看到之前每一天的墙（记录留一年）。
//  刚听过的亮一圈暖光，没挂满的格子是钉子而不是占位符。
//  数据只来自本机事件流，不出网。
// ====================================================================

const { DAY, timeOf, startOfDay, dayKeyOf, parseDayKey, fmtDate } = require('./event-time');

const FRESH_MS = 30 * 60 * 1000; // 半小时内听过的算「刚挂上」
const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();
const firstArtist = (v) => String(v == null ? '' : v).split(/[\/,、&]/)[0].trim();

function keyOf(song) {
  return norm(song && song.name) + '|' + norm(firstArtist(song && song.artist));
}

/**
 * @param {{events:Array, capacity?:number, day?:string, now?:number}} input
 *   day: 'YYYY-MM-DD'，省略则是今天
 */
function buildWall({ events = [], capacity = 24, day, now = Date.now() } = {}) {
  const parsed = parseDayKey(day);
  const from = parsed == null ? startOfDay(now) : parsed;
  const to = from + DAY;
  const key = dayKeyOf(from);
  const todayKey = dayKeyOf(now);

  const map = new Map();
  const seenDays = new Set();

  for (const e of events || []) {
    if (!e || !['play', 'complete', 'like'].includes(e.type)) continue;
    const s = e.song || {};
    if (!s.name) continue;
    const ts = timeOf(e);
    if (!ts) continue;
    // 翻页范围与「记录保留一年」一致，太老的日期不进导航
    if (ts < now - 365 * DAY) continue;
    const dk = dayKeyOf(ts);
    seenDays.add(dk);
    if (ts < from || ts >= to) continue; // 只留目标这一天

    const k = keyOf(s);
    const hit = map.get(k);
    if (!hit) {
      map.set(k, { song: s, first: ts, last: ts, plays: 1 });
    } else {
      hit.first = Math.min(hit.first, ts);
      hit.last = Math.max(hit.last, ts);
      hit.plays += 1;
      // 后出现的记录可能带封面 / 平台信息，补上
      if (!hit.song.cover && s.cover) hit.song.cover = s.cover;
      if (!hit.song.id && s.id) hit.song = Object.assign({}, hit.song, { id: s.id, provider: s.provider });
    }
  }

  const all = [...map.values()].sort((a, b) => b.last - a.last);
  const slots = [];
  for (let i = 0; i < capacity; i++) {
    const item = all[i];
    if (!item) { slots.push(null); continue; }
    slots.push({
      id: item.song.id || '',
      provider: item.song.provider || '',
      name: item.song.name,
      artist: item.song.artist || '',
      cover: item.song.cover || '',
      plays: item.plays,
      first: item.first,
      last: item.last,
      // 只是「刚听过」，不是「新歌」——墙本来就是当天的
      fresh: now - item.last <= FRESH_MS,
    });
  }

  const days = [...seenDays].sort().reverse();
  const hasPrev = days.some((d) => d < key);
  const hasNext = days.some((d) => d > key && d <= todayKey);

  const d0 = new Date(from);
  return {
    ok: true,
    day: key,
    dayLabel: parsed == null || key === todayKey
      ? `今天 · ${fmtDate(from)}`
      : `${fmtDate(from)} ${WEEKDAY[d0.getDay()]}`,
    isToday: key === todayKey,
    capacity,
    total: all.length,
    hung: Math.min(all.length, capacity),
    freshCount: all.filter((x) => now - x.last <= FRESH_MS).length,
    hasMore: all.length > capacity,
    hasPrev,
    hasNext,
    days,
    slots,
  };
}

module.exports = { buildWall, keyOf, FRESH_MS };
