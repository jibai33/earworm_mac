'use strict';
// ====================================================================
//  闻曲 · 每日登录彩蛋（服务端）
//  ------------------------------------------------------------------
//  和「登录彩蛋」不是一回事：那套是账号登录成功后的全屏四幕演出（要输暗号），
//  一天最多碰一次；这一套是「每天第一次打开闻曲」时掉出来的一张今日签，
//  不依赖账号、不需要暗号、不占屏幕。
//
//  几条硬规矩：
//    · 「今天」按本机时区算（用户在北京，就用北京的一天），不用 UTC
//    · status 只读，claim 才落盘 —— 刷新页面不会把连续天数刷上去
//    · 断签如实归 1，不假装连上（那种「已连续 1 天」的假安慰没有意义）
//    · 今日短句 / 坐标 / 动作全按日期稳定生成：同一天反复打开看到的是同一张签
//    · 不联网、不上报、不发通知；只写一个本地 json
// ====================================================================
const fs = require('fs');
const path = require('path');
const userPaths = require('../user-paths');

const VERSION = 'daily-egg-v1';
const STATE_FILE = userPaths.dataFile('.daily-egg.json');

/* ---------- 今日短句池 ----------
   写真话，不写励志。每条的 s 是副标，给主句一个落点。 */
const LINES = [
  { t: '把音量调低一格，今天适合听细节。', s: '小声的时候，编曲的缝里会漏出点东西。' },
  { t: '你有一段时间没翻旧歌了。', s: '那些歌不会跑，只是落了点灰。' },
  { t: '今天的风是从去年吹过来的。', s: '去年今天那一整页，还在原处。' },
  { t: '有一首歌你只听过半首。', s: '剩下的那半首，今天补上。' },
  { t: '别跳过前奏。', s: '好东西常常藏在第二十秒之后。' },
  { t: '今天的随机播放会偏向你没听过的。', s: '耳朵也需要一点新鲜空气。' },
  { t: '如果今天很吵，就戴上耳机。', s: '世界不会因此变小。' },
  { t: '深夜听歌别开太大声。', s: '耳朵是消耗品，用一次少一次。' },
  { t: '有首歌唱的就是你现在的样子。', s: '只是你还没在它下面按过播放。' },
  { t: '今天适合把一首歌循环到第三遍。', s: '第三遍，词才真正开始有味道。' },
  { t: '有张唱片还锁着。', s: '锁它的人是你自己。' },
  { t: '今天的调子偏暗一点。', s: '暗没关系，听得清就行。' },
  { t: '你上一次在评论里写字，是什么时候？', s: '有人会看见的。' },
  { t: '听一首完全不认识的歌，不许跳过。', s: '三分钟而已。' },
  { t: '今天适合从后往前听一张专辑。', s: '结尾往往比开头诚实。' },
  { t: '你收藏的歌里，有一半没再播过。', s: '它们在等你回来。' },
  { t: '把今天听过的做成一面墙。', s: '一个月后再看，会很有意思。' },
  { t: '今天的光线适合听慢的。', s: '慢下来不算浪费时间。' },
  { t: '有一首歌你曾经听哭过。', s: '它还记得那个版本的你。' },
  { t: '今天别开倍速。', s: '有些东西急不得。' },
  { t: '随机播放是个会说谎的人。', s: '它只放你听过的。' },
  { t: '今天适合完整听一张专辑。', s: '从第一首到最后一首，中间不切。' },
  { t: '你的口味比你以为的更宽。', s: '试试那个一直没点开的分类。' },
  { t: '播一首歌给旁边的人听。', s: '音乐是少数能直接分给别人的东西。' },
  { t: '今天适合听一首没有歌词的。', s: '让耳朵自己编故事。' },
  { t: '有时候安静的段落才是重点。', s: '别急着拖进度条。' },
  { t: '你听见的贝斯，是整首歌的地基。', s: '下次留意一下它。' },
  { t: '去年的这个时候，你在听别的歌。', s: '现在这首，也总有一天会过去。' },
  { t: '今天适合少听一点，多坐一会儿。', s: '安静也算一种收听。' },
  { t: '有一首歌，你的朋友会喜欢。', s: '发给他，理由可以只是「听到就想到你」。' },
  { t: '今天的运气藏在第 7 首里。', s: '数着听。' },
  { t: '你已经坐很久了。', s: '起来走两步再回来，歌不会停。' },
  { t: '今天的歌单可以短一点。', s: '三首就够。' },
  { t: '有些歌要听第二遍才成立。', s: '第一遍只是认路。' },
  { t: '今天适合听现场版。', s: '观众的声音也是编曲的一部分。' },
  { t: '你上一次从头听完一整张，是什么时候？', s: '不用急着回答。' },
  { t: '今天的耳机线别绕成一团。', s: '解开要四十秒，但那四十秒值得。' },
  { t: '有一首歌的前奏比副歌好听。', s: '我们不会告诉你是哪一首。' },
  { t: '今天适合把一首歌发给不常联系的人。', s: '借口现成的：突然想到你。' },
  { t: '你听得最多的那首，现在听会不一样。', s: '人会变，歌不变。' },
  { t: '今天也是可以被记住的一天。', s: '只要有一首歌刚好对上。' },
  { t: '别急着找下一首。', s: '这一首还没放完。' },
];

/* ---------- 今日坐标：调式 ---------- */
const TONES = [
  { name: 'C 大调', note: '最不设防的一种，什么都装得下' },
  { name: 'A 小调', note: '适合把话说一半' },
  { name: 'D 多利亚', note: '有一点旧，但不难过' },
  { name: 'F 利底亚', note: '亮得不太真实，像凌晨四点的天' },
  { name: 'G 混合利底亚', note: '走起路来会晃' },
  { name: 'E 弗里几亚', note: '偏硬，适合今天不想解释的时候' },
];

/* ---------- 今日动作：全部能真执行，不是文案 ----------
   id 由前端映射到具体函数，服务端只负责今天挑哪一个。 */
const ACTIONS = [
  { id: 'surprise', t: '给我一首意外的', hint: '从你的口味外面挑一首，白天也能用' },
  { id: 'lastyear', t: '再听去年今天', hint: '把去年这一天的歌拉回队列' },
  { id: 'today-wall', t: '重播今天的墙', hint: '今天听过的，一次全部倒回队列' },
  { id: 'daily-song', t: '播放今日一曲', hint: '每天只出一次的那首' },
  { id: 'crate', t: '去唱片店开一张', hint: '还锁着的那几张，条件已经凑得差不多' },
  { id: 'yearbook', t: '翻一眼听觉年鉴', hint: '看看这个月像什么样子' },
  { id: 'midnight', t: '切进深夜频道', hint: '现在不想睡的话' },
  { id: 'comments', t: '给这首歌留句话', hint: '评论区还开着' },
];

const MILESTONES = [3, 7, 14, 30, 60, 100, 180, 365];

/* ---------- 日期：一律本地时区 ---------- */
function pad(n) { return n < 10 ? '0' + n : String(n); }
function dayKey(d) {
  const t = d || new Date();
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}
function parseKey(k) {
  const [y, m, d] = String(k || '').split('-').map(Number);
  if (!y || !m || !d) return null;
  const t = new Date(y, m - 1, d);
  return Number.isNaN(t.getTime()) ? null : t;
}
function shiftKey(k, delta) {
  const t = parseKey(k);
  if (!t) return '';
  t.setDate(t.getDate() + delta);
  return dayKey(t);
}
function diffDays(from, to) {
  const a = parseKey(from), b = parseKey(to);
  if (!a || !b) return 0;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}
/* 从 2024-01-01 起的天序号：短句与动作的轮转轴 */
function dayNumber(k) { return diffDays('2024-01-01', k); }

function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0);
}

/* ---------- 状态 ---------- */
function defaultState() {
  return {
    version: VERSION,
    firstDay: '',
    lastDay: '',
    streak: 0,
    best: 0,
    total: 0,
    breaks: 0,
    lastClaimAt: 0,
    claimed: {},          // 只留最近 40 天，避免文件无限长
    milestones: [],
  };
}
function readState() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return defaultState(); }
  if (!raw || raw.version !== VERSION) return defaultState();
  const base = defaultState();
  return Object.assign(base, raw, {
    streak: Math.max(0, Number(raw.streak) || 0),
    best: Math.max(0, Number(raw.best) || 0),
    total: Math.max(0, Number(raw.total) || 0),
    breaks: Math.max(0, Number(raw.breaks) || 0),
    claimed: raw.claimed && typeof raw.claimed === 'object' ? raw.claimed : {},
    milestones: Array.isArray(raw.milestones) ? raw.milestones.slice(-12) : [],
  });
}
function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.error('[DailyEgg] 状态写入失败', e.message);
    throw e;
  }
  return state;
}

/* ---------- 今天就该看到什么 ---------- */
function preview(state, today) {
  const last = String(state.lastDay || '');
  const claimedToday = last === today;
  const yesterday = shiftKey(today, -1);
  let streak, broken;
  if (claimedToday) { streak = Math.max(1, state.streak); broken = false; }
  else if (last && last === yesterday) { streak = Math.max(1, state.streak) + 1; broken = false; }
  else if (!last) { streak = 1; broken = false; }
  else { streak = 1; broken = true; }
  return { claimedToday, streak, broken, gap: last && !claimedToday ? diffDays(last, today) : 0 };
}

function nextMilestone(streak) {
  for (const m of MILESTONES) if (m > streak) return m;
  return null;
}

function card(today, streak) {
  const n = dayNumber(today);
  const line = LINES[((n % LINES.length) + LINES.length) % LINES.length];
  const tone = TONES[hash(today + ':tone') % TONES.length];
  const bpm = 62 + (hash(today + ':bpm') % 71);
  // 动作与短句错开轮转，避免「句子换了动作没换」的呆板
  const action = ACTIONS[((n * 3 + 1) % ACTIONS.length + ACTIONS.length) % ACTIONS.length];
  const hit = MILESTONES.includes(streak);
  const next = nextMilestone(streak);
  return {
    line, tone, bpm, action,
    milestone: hit ? streak : 0,
    next, left: next ? next - streak : 0,
  };
}

function status(now) {
  const today = dayKey(now);
  const state = readState();
  const p = preview(state, today);
  const c = card(today, p.streak);
  return {
    ok: true,
    version: VERSION,
    today,
    no: state.total + (p.claimedToday ? 0 : 1),
    isNew: !p.claimedToday,
    claimed: p.claimedToday,
    skippedToday: String(state.skipped || '') === today,
    streak: p.streak,
    best: Math.max(state.best, p.streak),
    total: state.total,
    broken: p.broken,
    // claim 之后 broken 会被清掉（lastDay 已经是今天），保留一份「今天这次是不是断签重来」
    wasBroken: p.broken,
    gap: p.gap,
    firstDay: state.firstDay || '',
    ...c,
  };
}

/** 收下今天这张签：同一天重复调用只累加一次 */
function claim(now) {
  const today = dayKey(now);
  const state = readState();
  const p = preview(state, today);
  if (p.claimedToday) {
    const s = status(now);
    return Object.assign(s, { alreadyClaimed: true });
  }
  if (!state.firstDay) state.firstDay = today;
  if (p.broken) state.breaks = Number(state.breaks || 0) + 1;
  state.lastDay = today;
  state.streak = p.streak;
  state.best = Math.max(Number(state.best || 0), p.streak);
  state.total = Number(state.total || 0) + 1;
  state.lastClaimAt = Date.now();
  state.claimed[today] = 1;
  if (MILESTONES.includes(p.streak)) state.milestones = (state.milestones || []).concat([{ day: p.streak, at: Date.now() }]).slice(-12);
  // 只留最近 40 个日期键
  const keys = Object.keys(state.claimed).sort();
  while (keys.length > 40) delete state.claimed[keys.shift()];
  try { writeState(state); } catch { /* 只读盘也不该挡人 */ }
  const view = status(now);
  return Object.assign(view, { alreadyClaimed: false, wasBroken: p.broken, broken: false });
}

/** 今天不看了：不改连续天数，只在当天标记一下，免得刷新又弹 */
function skip(now) {
  const today = dayKey(now);
  const state = readState();
  state.skipped = today;
  try { writeState(state); } catch { /* 忽略 */ }
  return Object.assign(status(now), { skipped: true });
}

module.exports = {
  VERSION, STATE_FILE, LINES, TONES, ACTIONS, MILESTONES,
  dayKey, shiftKey, diffDays,
  status, claim, skip,
  readState,
};
