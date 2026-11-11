'use strict';
// ====================================================================
//  闻曲 · 登录彩蛋状态机（服务端）
//  ------------------------------------------------------------------
//  两套「输入暗号 → 播放像素动画」的彩蛋：
//    · first  初次登录：世界和平（致敬 Mineradio 的登录愿望门）
//    · return 退出后重新登录：好久不见
//  口令只在服务端校验，前端只拿到谜面、字数和渐进提示；
//  状态落盘到用户数据目录，跨重启保留「是否曾经登录过」。
// ====================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const userPaths = require('../user-paths');

const VERSION = 'pixel-login-egg-v1';
const STATE_FILE = userPaths.dataFile('.login-egg.json');

const DEFS = {
  first: {
    kind: 'first',
    phrase: '世界和平',
    title: '初次相遇',
    riddle: '天下无战事，人间皆安好。',
    hint: '和 Mineradio 开机时那句愿望，是同一句话。',
    subtitle: '第一次把耳朵交给闻曲，先许一个愿。',
    sceneTitle: '初次见面，这里是闻曲',
    sceneLine: '从今天起，这里会记得你听过的每一首歌。',
    badge: 'EASTER EGG 01',
  },
  return: {
    kind: 'return',
    phrase: '好久不见',
    title: '久别重逢',
    riddle: '久别之后，开口的第一句话。',
    hint: '不是「你好」，也不是「回来了」——比它们更旧一点。',
    subtitle: '你走的时候，灯没有关。',
    sceneTitle: '欢迎回来，位置还留着',
    sceneLine: '歌单、口味、还有那句没说完的话，都在原处。',
    badge: 'EASTER EGG 02',
  },
};

function defaultState() {
  return {
    version: VERSION,
    everLoggedIn: false,
    loginCount: 0,
    logoutCount: 0,
    lastKind: '',
    lastLoginAt: 0,
    lastLogoutAt: 0,
    pending: null,
    attempts: { first: 0, return: 0 },
    unlocked: { first: false, return: false },
    history: [],
  };
}

function readState() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return defaultState(); }
  if (!raw || raw.version !== VERSION) return defaultState();
  const base = defaultState();
  return Object.assign(base, raw, {
    attempts: Object.assign({}, base.attempts, raw.attempts || {}),
    unlocked: Object.assign({}, base.unlocked, raw.unlocked || {}),
    history: Array.isArray(raw.history) ? raw.history.slice(-20) : [],
  });
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.error('[LoginEgg] 状态写入失败', e.message);
    throw e;
  }
  return state;
}

function publicDef(kind) {
  const d = DEFS[kind];
  if (!d) return null;
  const { phrase, ...safe } = d; // 口令绝不下发
  return Object.assign({}, safe, { chars: Array.from(phrase).length });
}

function pendingView(state) {
  const p = state.pending;
  if (!p || !DEFS[p.kind]) return null;
  const attempts = Number(state.attempts[p.kind] || 0);
  const phrase = DEFS[p.kind].phrase;
  let reveal = '';
  if (attempts >= 3) reveal = Array.from(phrase).slice(0, 2).join('');
  else if (attempts >= 2) reveal = Array.from(phrase).slice(0, 1).join('');
  return Object.assign(publicDef(p.kind), {
    provider: String(p.provider || ''),
    at: Number(p.at || 0),
    attempts,
    reveal,
  });
}

function status() {
  const state = readState();
  return {
    ok: true,
    version: VERSION,
    everLoggedIn: state.everLoggedIn === true,
    loginCount: Number(state.loginCount || 0),
    logoutCount: Number(state.logoutCount || 0),
    lastKind: String(state.lastKind || ''),
    pending: pendingView(state),
    unlocked: Object.assign({}, state.unlocked),
  };
}

function pushHistory(state, entry) {
  state.history = (state.history || []).concat([Object.assign({ at: Date.now() }, entry)]).slice(-20);
}

/** 登录成功：首次 → first 彩蛋；之后（含退出重登）→ return 彩蛋 */
function markLogin(provider) {
  const state = readState();
  const kind = state.everLoggedIn ? 'return' : 'first';
  // 已经有一个没拆的彩蛋就别覆盖，避免多平台连续授权时把前一个吞掉
  if (!state.pending || !DEFS[state.pending.kind]) {
    state.pending = { kind, provider: String(provider || ''), at: Date.now() };
  }
  state.everLoggedIn = true;
  state.loginCount = Number(state.loginCount || 0) + 1;
  state.lastLoginAt = Date.now();
  pushHistory(state, { type: 'login', provider: String(provider || ''), kind });
  try { writeState(state); } catch { /* 只读盘也不该阻断登录 */ }
  return status();
}

/** 退出登录：记一笔，下次登录就能拿到「久别重逢」 */
function markLogout(provider) {
  const state = readState();
  state.logoutCount = Number(state.logoutCount || 0) + 1;
  state.lastLogoutAt = Date.now();
  // 未拆的彩蛋先收起来，退出后重新登录会重新发一枚
  if (state.pending) state.pending = null;
  pushHistory(state, { type: 'logout', provider: String(provider || '') });
  try { writeState(state); } catch { /* 同上 */ }
  return status();
}

function secureMatch(input, expected) {
  const a = Buffer.from(String(input || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** 核对暗号。错 2 次给首字，错 3 次给前两字（参考 Mineradio 的渐进提示） */
function check(value) {
  const state = readState();
  const p = state.pending;
  if (!p || !DEFS[p.kind]) return { ok: false, error: 'NO_PENDING_EGG', message: '当前没有待拆的彩蛋' };
  const def = DEFS[p.kind];
  const input = Array.from(String(value || '').replace(/\s+/g, '')).join('');
  if (!secureMatch(input, def.phrase)) {
    state.attempts[p.kind] = Number(state.attempts[p.kind] || 0) + 1;
    try { writeState(state); } catch { /* 忽略 */ }
    const attempts = state.attempts[p.kind];
    return {
      ok: false,
      error: 'PHRASE_MISMATCH',
      message: attempts >= 3 ? '前两个字，已经替你想好了' : attempts === 2 ? '再给你一个字' : '愿望不太对，再想想',
      attempts,
      reveal: pendingView(state).reveal,
    };
  }
  const kind = p.kind;
  state.pending = null;
  state.attempts[kind] = 0;
  state.unlocked[kind] = true;
  state.lastKind = kind;
  pushHistory(state, { type: 'unlock', kind });
  try { writeState(state); } catch { /* 忽略 */ }
  return { ok: true, kind, scene: publicDef(kind) };
}

/** 跳过：不解锁、不消费成就，但本次不再弹 */
function skip() {
  const state = readState();
  pushHistory(state, { type: 'skip', kind: state.pending && state.pending.kind || '' });
  state.pending = null;
  try { writeState(state); } catch { /* 忽略 */ }
  return status();
}

/** 主动重播（账号卡片里的「再看一次」） */
function replay(kind) {
  const k = DEFS[kind] ? kind : 'first';
  const state = readState();
  state.pending = { kind: k, provider: 'replay', at: Date.now() };
  state.attempts[k] = 0;
  try { writeState(state); } catch { /* 忽略 */ }
  return status();
}

module.exports = {
  VERSION,
  DEFS,
  status,
  markLogin,
  markLogout,
  check,
  skip,
  replay,
  secureMatch,
  readState,
};
