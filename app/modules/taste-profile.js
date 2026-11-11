// ====================================================================
//  闻曲 · 听感画像（平台无关）
//  Web / macOS / iOS 共用同一份画像：同一个服务地址 + 同一个同步码。
//  纯 HTTP JSON 契约，不依赖任何平台 SDK；事件按 id 去重，30 天滑动窗口。
// ====================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = require('../user-paths').DATA_DIR;
const STORE = path.join(DATA_DIR, 'taste-profiles.json');
// 事件留一年：听觉年鉴要能看到去年这个时候，唱片墙要能翻回之前每一天。
// 条数上限按「一年里正常听歌量」给足，避免把去年的记录挤掉。
const WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_EVENTS = 12000;
const MAX_BATCH = 200;
const VALID_TYPES = new Set(['play', 'complete', 'skip', 'search', 'view', 'like', 'unlike']);
const KEY_RE = /^[A-Z0-9]{12,32}$/;

let db = { version: 1, profiles: {} };

/* ---------- 持久化 ---------- */
function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    if (raw && raw.profiles && typeof raw.profiles === 'object') db = raw;
  } catch { /* 首次运行或文件损坏：从空库开始 */ }
}
function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = STORE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, STORE);
  } catch (e) {
    console.error('[Taste] 画像写入失败:', e.message);
    throw e;
  }
}
load();

/* ---------- 同步码 ---------- */
// 形如 EW-7KQ2-M9XR-4T8P；去掉前缀与连字符后为 12 位大写字母数字
function normalizeKey(input) {
  let s = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.startsWith('EW')) s = s.slice(2);
  return s;
}
function isValidKey(input) { return KEY_RE.test(normalizeKey(input)); }
function prettyKey(key) {
  const k = normalizeKey(key);
  return 'EW-' + k.slice(0, 4) + '-' + k.slice(4, 8) + '-' + k.slice(8, 12);
}
function createSyncKey() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆字符
  const bytes = crypto.randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/* ---------- 画像 ---------- */
function blankProfile(key) {
  const now = Date.now();
  return {
    key, createdAt: now, updatedAt: now,
    events: [],
    settings: { enabled: true, shareAcrossDevices: true, windowDays: 30 },
    feedback: { songs: {}, artists: {}, keywords: {} },
    devices: {},
  };
}
function ensureProfile(key) {
  const k = normalizeKey(key);
  if (!isValidKey(k)) throw new Error('同步码格式不对（应为 EW-XXXX-XXXX-XXXX）');
  if (!db.profiles[k]) { db.profiles[k] = blankProfile(k); persist(); }
  return db.profiles[k];
}
function prune(p, now = Date.now()) {
  const cutoff = now - WINDOW_MS;
  const before = p.events.length;
  p.events = p.events.filter(e => Number(e.ts) >= cutoff);
  if (p.events.length > MAX_EVENTS) p.events = p.events.slice(-MAX_EVENTS);
  return before - p.events.length;
}
function publicProfile(p) {
  return {
    syncKey: prettyKey(p.key),
    createdAt: p.createdAt, updatedAt: p.updatedAt,
    eventCount: p.events.length,
    settings: Object.assign({}, p.settings),
    feedback: p.feedback,
    devices: Object.keys(p.devices).map(id => ({
      id, platform: p.devices[id].platform,
      firstSeen: p.devices[id].firstSeen, lastSeen: p.devices[id].lastSeen,
      events: p.devices[id].events,
    })),
  };
}
function getProfile(key) { return publicProfile(ensureProfile(key)); }

/* ---------- 事件上报 ---------- */
function cleanEvent(raw, deviceId, platform, now) {
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.type || '').toLowerCase();
  if (!VALID_TYPES.has(type)) return null;
  const str = (v, n) => String(v == null ? '' : v).slice(0, n);
  const song = raw.song && typeof raw.song === 'object' ? raw.song : {};
  return {
    id: str(raw.id, 64) || crypto.randomBytes(8).toString('hex'),
    type,
    ts: now,
    clientTs: Number(raw.ts) || now,
    deviceId: str(deviceId, 64),
    platform: str(platform, 24),
    song: {
      id: str(song.id, 64),
      name: str(song.name, 160),
      artist: str(song.artist, 160),
      provider: str(song.provider, 24),
      cover: str(song.cover, 400),
      keyword: str(song.keyword, 120),
    },
    meta: {
      keyword: str(raw.meta && raw.meta.keyword, 120),
      context: str(raw.meta && raw.meta.context, 120),
      duration: Math.max(0, Math.min(86400, Number(raw.meta && raw.meta.duration) || 0)),
    },
  };
}

/**
 * 批量上报。同一 event.id 只入库一次，因此多端离线重放是安全的。
 * @returns {{ok, accepted, deduped, total, updatedAt, syncKey}}
 */
function ingest({ syncKey, deviceId, platform, events }) {
  const p = ensureProfile(syncKey);
  const now = Date.now();
  const list = Array.isArray(events) ? events.slice(0, MAX_BATCH) : [];
  const seen = new Set(p.events.map(e => e.id));
  let accepted = 0, deduped = 0;
  for (const raw of list) {
    const e = cleanEvent(raw, deviceId, platform, now);
    if (!e) continue;
    if (seen.has(e.id)) { deduped++; continue; }
    seen.add(e.id);
    p.events.push(e);
    accepted++;
  }
  const dev = strDevice(deviceId);
  if (!p.devices[dev]) p.devices[dev] = { platform: String(platform || 'unknown').slice(0, 24), firstSeen: now, lastSeen: now, events: 0 };
  p.devices[dev].lastSeen = now;
  p.devices[dev].events += accepted;
  prune(p, now);
  p.updatedAt = now;
  if (accepted || deduped) persist();
  return { ok: true, accepted, deduped, total: p.events.length, updatedAt: p.updatedAt, syncKey: prettyKey(p.key) };
}
function strDevice(d) { return String(d || 'anonymous').slice(0, 64); }

/** 增量拉取：since 为上次拿到的 updatedAt，返回此后新入库的事件 */
function getEvents(key, since, limit) {
  const p = ensureProfile(key);
  const s = Number(since) || 0;
  const max = Math.min(MAX_EVENTS, Math.max(1, Number(limit) || MAX_EVENTS));
  const items = s > 0 ? p.events.filter(e => Number(e.ts) > s) : p.events.slice();
  return {
    ok: true,
    events: items.slice(-max),
    updatedAt: p.updatedAt,
    total: p.events.length,
    syncKey: prettyKey(p.key),
  };
}

/* ---------- 设置 / 反馈 / 隐私 ---------- */
function setSettings(key, patch) {
  const p = ensureProfile(key);
  const s = patch && typeof patch === 'object' ? patch : {};
  if (typeof s.enabled === 'boolean') p.settings.enabled = s.enabled;
  if (typeof s.shareAcrossDevices === 'boolean') p.settings.shareAcrossDevices = s.shareAcrossDevices;
  const days = Number(s.windowDays);
  if (Number.isFinite(days) && days >= 1 && days <= 365) p.settings.windowDays = Math.round(days);
  p.updatedAt = Date.now();
  persist();
  return { ok: true, settings: Object.assign({}, p.settings) };
}
function addFeedback(key, { kind, value, action }) {
  const p = ensureProfile(key);
  const k = String(kind || 'song');
  const v = String(value || '').slice(0, 160).trim();
  const a = String(action || 'dislike');
  if (!v || !['song', 'artist', 'keyword'].includes(k)) return { ok: false, error: 'bad feedback' };
  const bucket = k === 'song' ? p.feedback.songs : k === 'artist' ? p.feedback.artists : p.feedback.keywords;
  bucket[v] = { action: a, ts: Date.now() };
  // 只保留最近 200 条反馈，避免无限增长
  const keys = Object.keys(bucket);
  if (keys.length > 200) keys.slice(0, keys.length - 200).forEach(x => delete bucket[x]);
  p.updatedAt = Date.now();
  persist();
  return { ok: true, feedback: p.feedback };
}
function isSuppressed(p, song) {
  const name = String(song && song.name || '').trim();
  const artist = String(song && song.artist || '').trim();
  const kw = String(song && song.keyword || '').trim();
  const bad = (bucket, v) => !!(v && p.feedback[bucket][v] && p.feedback[bucket][v].action !== 'like');
  return bad('songs', name) || bad('artists', artist) || bad('keywords', kw);
}
function clearProfile(key, { keepSettings = true } = {}) {
  const p = ensureProfile(key);
  p.events = [];
  p.feedback = { songs: {}, artists: {}, keywords: {} };
  p.devices = {};
  if (!keepSettings) p.settings = { enabled: true, shareAcrossDevices: true, windowDays: 30 };
  p.updatedAt = Date.now();
  persist();
  return { ok: true, eventCount: 0 };
}
function exportProfile(key) {
  const p = ensureProfile(key);
  return { ok: true, syncKey: prettyKey(p.key), exportedAt: Date.now(), profile: publicProfile(p), events: p.events };
}

/** 绑定已有同步码：把 fromKey 的事件合并进 toKey（多端首次汇合） */
function bindSyncKey(fromKey, toKey) {
  const src = ensureProfile(fromKey);
  const dst = ensureProfile(toKey);
  if (src.key === dst.key) return { ok: true, merged: 0, syncKey: prettyKey(dst.key) };
  const seen = new Set(dst.events.map(e => e.id));
  let merged = 0;
  for (const e of src.events) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    dst.events.push(e);
    merged++;
  }
  for (const [id, d] of Object.entries(src.devices)) {
    if (!dst.devices[id]) dst.devices[id] = d;
  }
  for (const bucket of ['songs', 'artists', 'keywords']) {
    Object.assign(dst.feedback[bucket], src.feedback[bucket]);
  }
  dst.events.sort((a, b) => a.ts - b.ts);
  prune(dst);
  delete db.profiles[src.key];
  dst.updatedAt = Date.now();
  persist();
  return { ok: true, merged, syncKey: prettyKey(dst.key) };
}

module.exports = {
  WINDOW_MS, MAX_EVENTS, VALID_TYPES,
  normalizeKey, isValidKey, prettyKey, createSyncKey,
  ensureProfile, getProfile, publicProfile,
  ingest, getEvents, setSettings, addFeedback, isSuppressed,
  clearProfile, exportProfile, bindSyncKey,
  rawProfile: (key) => ensureProfile(key),
  stats: () => ({ profiles: Object.keys(db.profiles).length, events: Object.values(db.profiles).reduce((n, p) => n + p.events.length, 0) }),
};
