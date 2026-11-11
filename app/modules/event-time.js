'use strict';

// ====================================================================
//  闻曲 · 事件时间工具
//  ------------------------------------------------------------------
//  事件里有两个时间：
//    ts       服务端收到的时刻（离线补报时会全部挤成「今天」）
//    clientTs 产生这条记录的时刻（客户端本地时钟）
//  统计必须用「发生时间」，否则冷启动补报会把一周前的歌算进今天的墙。
//  clientTs 只在合理范围内采信，防止系统时钟被改坏后污染历史。
// ====================================================================

const DAY = 24 * 60 * 60 * 1000;
const pad2 = (n) => String(n).padStart(2, '0');

/** 记录真正的发生时间 */
function timeOf(e) {
  const t = Number(e && e.ts) || 0;
  const c = Number(e && e.clientTs) || 0;
  if (!c) return t;
  // 只有「跑到未来」的时钟不可信。太早的时间要保留原样：
  // 那是真的老记录，回落到 ts 反而会把去年的歌算进今天。
  if (c > t + DAY) return t;
  return c;
}

function startOfDay(ts) {
  const d = new Date(Number(ts) || Date.now());
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 本地日期键 YYYY-MM-DD（不能用 toISOString，那是 UTC） */
function dayKeyOf(ts) {
  const d = new Date(Number(ts) || 0);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 'YYYY-MM-DD' → 当天 00:00 的时间戳；非法则 null */
function parseDayKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  if (Number.isNaN(d.getTime())) return null;
  // 反向校验，挡掉 2026-02-31 这类日期
  return dayKeyOf(d.getTime()) === key ? d.getTime() : null;
}

/** 周一为一周之始（国内习惯） */
function startOfWeek(ts) {
  const d = new Date(Number(ts) || Date.now());
  d.setHours(0, 0, 0, 0);
  const wd = (d.getDay() + 6) % 7; // 周一=0
  d.setDate(d.getDate() - wd);
  return d.getTime();
}

function startOfMonth(ts) {
  const d = new Date(Number(ts) || Date.now());
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  return d.getTime();
}

function startOfYear(ts) {
  const d = new Date(Number(ts) || Date.now());
  d.setHours(0, 0, 0, 0);
  d.setMonth(0, 1);
  return d.getTime();
}

/**
 * 该时间所属的周序号（ISO 口径：周一为一周之始，用本周四定年份）
 * 与手机日历、日历软件显示的第 N 周一致
 */
function weekIndex(ts) {
  const mon = new Date(startOfWeek(ts));
  const thu = new Date(mon.getTime() + 3 * DAY);
  const yearStart = new Date(thu.getFullYear(), 0, 1);
  const days = Math.round((thu - yearStart) / DAY);
  return Math.floor(days / 7) + 1;
}

const fmtTime = (ts) => {
  const d = new Date(Number(ts) || 0);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

const fmtDate = (ts) => {
  const d = new Date(Number(ts) || 0);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
};

/** 11.09 这种紧凑写法，给版面窄的地方用 */
const fmtShortDate = (ts) => {
  const d = new Date(Number(ts) || 0);
  return `${d.getMonth() + 1}.${pad2(d.getDate())}`;
};

/** 2026.11.11，跨年比较时用 */
const fmtYMD = (ts) => {
  const d = new Date(Number(ts) || 0);
  return `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`;
};

module.exports = {
  DAY, timeOf, startOfDay, startOfWeek, startOfMonth, startOfYear,
  dayKeyOf, parseDayKey, weekIndex, fmtTime, fmtDate, fmtShortDate, fmtYMD,
};
