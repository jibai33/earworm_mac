'use strict';

// ====================================================================
//  闻曲 · 隐藏唱片店（CRATE DIGGING）
//  ------------------------------------------------------------------
//  彩蛋看完就没了，太可惜。这里把它变成「收集」：每达成一件事，抽屉里
//  多一张能真的播放的唱片（8-bit 片段由前端现场合成，不占包体）。
//  解锁条件一律可验证：要么来自彩蛋状态机，要么来自事件流，要么来自
//  本文件的计数器——不编造进度，也不给「再来一次」的假按钮。
// ====================================================================

const fs = require('fs');
const userPaths = require('../user-paths');
const loginEgg = require('./login-egg');

const VERSION = 'pixel-crate-v1';
const STORE = userPaths.dataFile('.crate.json');

// seed 决定前端合成的旋律；两个数字不同 = 两首不同的曲子
const RECORDS = [
  {
    id: 'first', side: 'SIDE A', title: '初次相遇', kind: '8-bit', seed: 11, key: 'C',
    how: '在初次登录的彩蛋里输入暗号',
    hint: '第一次把耳朵交给闻曲时，那句愿望。',
  },
  {
    id: 'return', side: 'SIDE B', title: '久别重逢', kind: '8-bit', seed: 29, key: 'A',
    how: '退出登录后重新登录，再拆一次彩蛋',
    hint: '走的时候灯没关，回来时还在原处。',
  },
  {
    id: 'rain', side: 'SIDE C', title: '雨夜电台', kind: '8-bit', seed: 47, key: 'D',
    how: '打开过一次深夜频道',
    hint: '等一个还醒着的凌晨。',
  },
  {
    id: 'odd', side: 'SIDE D', title: '意外的一首', kind: '8-bit', seed: 63, key: 'E',
    how: '用过一次「给我一首意外的」',
    hint: '故意不按画像来一次。',
  },
  {
    id: 'wall', side: 'SIDE E', title: '唱片墙', kind: '8-bit', seed: 83, key: 'G',
    how: '记录里出现过 12 首不同的曲子',
    hint: '先让墙上挂满第一排。',
  },
  {
    id: 'morning', side: 'SIDE F', title: '清晨六点', kind: '8-bit', seed: 97, key: 'F',
    how: '在 5–8 点之间听过一首',
    hint: '天亮之后，第一首歌。',
  },
  {
    id: 'allnight', side: 'SIDE G', title: '通宵', kind: '8-bit', seed: 113, key: 'B',
    how: '在 0–5 点之间听过一首',
    hint: '和深夜频道不是同一件事。',
  },
  {
    id: 'complete', side: 'SIDE H', title: '黑胶 B 面', kind: '合集', seed: 131, key: 'C',
    how: '集齐前七张',
    hint: '把抽屉装到只剩一格。',
  },
];

const BY_ID = new Map(RECORDS.map((r) => [r.id, r]));

function defaultDb() {
  return { version: VERSION, unlocked: {}, counters: { rain: 0, odd: 0 } };
}

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    if (!raw || raw.version !== VERSION) return defaultDb();
    return {
      version: VERSION,
      unlocked: Object.assign({}, raw.unlocked || {}),
      counters: Object.assign({ rain: 0, odd: 0 }, raw.counters || {}),
    };
  } catch { return defaultDb(); }
}

function write(db) {
  try {
    fs.mkdirSync(require('path').dirname(STORE), { recursive: true });
    const tmp = `${STORE}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tmp, STORE);
  } catch (e) {
    console.error('[Crate] 写入失败', e.message);
  }
  return db;
}

let db = read();

/** 计数：雨夜电台 / 意外的一首这类没有事件流可依的，就在本地记一笔 */
function mark(what) {
  const k = String(what || '');
  if (k === 'rain' || k === 'odd') {
    db.counters[k] = Number(db.counters[k] || 0) + 1;
    write(db);
  }
  return { ok: true, counters: Object.assign({}, db.counters) };
}

function hourOf(ts) { return new Date(Number(ts) || 0).getHours(); }

/**
 * 依据现有事实算出解锁状态。
 * @param {{events?:Array}} input 事件流（可选，用于 wall / morning / allnight）
 */
function evaluate({ events = [] } = {}) {
  const egg = loginEgg.readState();
  const plays = (events || []).filter((e) => e && ['play', 'complete'].includes(e.type));
  const distinct = new Set(plays.map((e) => `${String(e.song && e.song.name || '').toLowerCase()}|${String(e.song && e.song.artist || '').toLowerCase()}`));
  const nightPlays = plays.filter((e) => hourOf(e.ts) < 5).length;
  const morningPlays = plays.filter((e) => { const h = hourOf(e.ts); return h >= 5 && h < 8; }).length;

  const facts = {
    first: !!(egg.unlocked && egg.unlocked.first),
    return: !!(egg.unlocked && egg.unlocked.return),
    rain: Number(db.counters.rain || 0) > 0,
    odd: Number(db.counters.odd || 0) > 0,
    wall: distinct.size >= 12,
    morning: morningPlays > 0,
    allnight: nightPlays > 0,
  };
  // 「集齐前七张」最后算，且不把自己算进去
  facts.complete = ['first', 'return', 'rain', 'odd', 'wall', 'morning', 'allnight'].every((id) => facts[id]);

  let changed = false;
  const now = Date.now();
  for (const r of RECORDS) {
    if (facts[r.id] && !db.unlocked[r.id]) { db.unlocked[r.id] = now; changed = true; }
  }
  if (changed) write(db);

  const records = RECORDS.map((r) => ({
    id: r.id, side: r.side, title: r.title, kind: r.kind, seed: r.seed, key: r.key,
    how: r.how, hint: r.hint,
    unlocked: !!db.unlocked[r.id],
    at: Number(db.unlocked[r.id] || 0),
  }));
  const count = records.filter((r) => r.unlocked).length;
  const next = records.find((r) => !r.unlocked) || null;

  return {
    ok: true,
    total: records.length,
    count,
    records,
    next,
    facts: Object.assign({}, facts, { distinct: distinct.size, nightPlays, morningPlays }),
  };
}

module.exports = { VERSION, RECORDS, BY_ID, mark, evaluate, read };
