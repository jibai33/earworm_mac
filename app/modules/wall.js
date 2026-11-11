'use strict';

// ====================================================================
//  闻曲 · 像素唱片墙
//  ------------------------------------------------------------------
//  听过的东西按「钉在墙上」排：最近先上墙，7 天内新挂的带暖光，没挂满
//  的格子是钉子而不是占位符。数据只来自本机事件流，不出网。
// ====================================================================

const DAY = 24 * 60 * 60 * 1000;

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();
const firstArtist = (v) => String(v == null ? '' : v).split(/[\/,、&]/)[0].trim();

function keyOf(song) {
  return norm(song && song.name) + '|' + norm(firstArtist(song && song.artist));
}

/**
 * @param {{events:Array, capacity?:number, now?:number}} input
 */
function buildWall({ events = [], capacity = 24, now = Date.now() } = {}) {
  const map = new Map();
  for (const e of events || []) {
    if (!e || !['play', 'complete', 'like'].includes(e.type)) continue;
    const s = e.song || {};
    if (!s.name) continue;
    const k = keyOf(s);
    const hit = map.get(k);
    const ts = Number(e.ts) || now;
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
  const recent7 = all.filter((x) => now - x.first <= 7 * DAY).length;
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
      isNew: now - item.first <= 7 * DAY,
    });
  }

  return {
    ok: true,
    capacity,
    total: all.length,
    hung: Math.min(all.length, capacity),
    newIn7d: recent7,
    hasMore: all.length > capacity,
    slots,
  };
}

module.exports = { buildWall, keyOf };
