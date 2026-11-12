/* 闻曲 Earworm — Web 播放器 v1.1：逐字卡拉 + 持久化 + 音质 + 快捷键 */
const $ = (id) => document.getElementById(id);
const audio = $('audio');

/* API 基地址：本地/自部署为空；GitHub Pages 部署时默认指向云端服务 */
const IS_PAGES = location.hostname.endsWith('github.io');
const CLOUD_API = 'https://earworm-music.app.workbuddy.host';
const CLOUD_SHARECODE = '66G2SQ67OM';
let API_BASE = localStorage.getItem('ew_api') || (IS_PAGES ? CLOUD_API : '');
function apiUrl(path) {
  if (!API_BASE) return path;
  const sep = path.includes('?') ? '&' : '?';
  const code = API_BASE === CLOUD_API ? CLOUD_SHARECODE : localStorage.getItem('ew_sharecode') || '';
  return API_BASE + path + sep + (code ? 'sharecode=' + code : '');
}

const POEMS = [
  '此曲只应天上有，人间能得几回闻。',
  '为我一挥手，如听万壑松。',
  '转轴拨弦三两声，未成曲调先有情。',
  '余音绕梁，三日不绝。',
  '谁家玉笛暗飞声，散入春风满洛城。',
  '嘈嘈切切错杂弹，大珠小珠落玉盘。',
];

const QUALITIES = [
  { key: 'standard', label: '标准' },
  { key: 'exhigh', label: '极高' },
  { key: 'lossless', label: '无损' },
  { key: 'hires', label: 'Hi-Res' },
];

const state = {
  queue: [], index: -1, playing: false,
  lyrics: [], curLyric: -1, karaoke: false,
  qrKey: null, qrTimer: null,
  offset: 0, keyword: '',
  mode: localStorage.getItem('ew_mode') || 'order',
  quality: localStorage.getItem('ew_quality') || 'exhigh',
  liked: {}, user: null,
  pendingSeek: 0,
  // 连续「取不到地址」的计数：到上限就停，防止在整批坏歌上空转
  failStreak: 0, _curSrc: '', _playStartedAt: 0,
  // v2 默认「全部音源」：一次检索/一屏浏览覆盖所有已连接平台，不再手动切换
  provider: localStorage.getItem('ew_provider_v2') || 'all',
  unifiedPage: 0, unifiedSources: [], accountStatus: null,
};
const PROVIDER_LABEL = { netease: '云村', qq: 'QQ 音乐', qishui: '汽水', xy: '小宇宙', all: '全部音源' };
/* v2：成就解锁时菜单栏图标闪一下；drawSpectrum 在这一刻把 8 段推满 */
let trayFlashUntil = 0;
let queueGen = 0;

/* ---------- 工具 ---------- */
const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const escapeHtml = (s) => String(s || '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const coverUrl = (u) => u ? apiUrl(`/api/cover?url=${encodeURIComponent(u)}`) : '';
const plural = (n) => n >= 10000 ? (n / 10000).toFixed(1) + ' 万' : n;
/* 登录彩蛋：跨启动记住各平台登录位图，只在「状态真的变化」时上报事件 */
let eggLoginMap = null;
try { eggLoginMap = JSON.parse(localStorage.getItem('ew_login_map') || 'null'); } catch { }

async function api(path, opts) {
  let r;
  try { r = await fetch(apiUrl(path), opts); }
  catch (e) {
    throw new Error('连接不上闻曲服务——请确认通过 http://localhost:3210/app/ 打开（而不是文件或静态预览），且 node server.js 正在运行');
  }
  if (!r.ok && r.status >= 500) throw new Error('服务出错（HTTP ' + r.status + '），看服务端日志');
  return r.json();
}

/* ---------- API 地址设置（Pages 模式） ---------- */
if (IS_PAGES) {
  document.addEventListener('DOMContentLoaded', () => {
    const tip = document.createElement('div');
    tip.className = 'api-tip';
    tip.innerHTML = API_BASE
      ? `在线版 · 服务：<code>${escapeHtml(API_BASE)}</code> <button class="text-btn" onclick="setApiBase()">修改</button>`
      : `在线版需要指定服务地址 <button class="brush-btn" onclick="setApiBase()">设置</button>`;
    document.body.prepend(tip);
  });
}
function setApiBase() {
  const v = prompt('填入闻曲服务地址（如 https://your-server.com）', API_BASE);
  if (v !== null) { localStorage.setItem('ew_api', v.trim()); location.reload(); }
}

/* ---------- 对外小接口：给 night.js / crate.js 这类同页模块用 ----------
   它们是同一文档里的普通脚本，直接读不到闭包里的 state，所以在这里开口子。
   只暴露「放一组歌」和「跳页」，不暴露内部状态，避免别处偷偷改队列。 */
window.EW = {
  play(songs, index) {
    const list = (songs || []).filter(Boolean);
    if (!list.length) return;
    queueGen += 1;
    state.queue = list.slice();
    renderQueue();
    playIndex(Math.max(0, Math.min(list.length - 1, index || 0)));
  },
  go: (page) => go(page),
  api: (path, opts) => api(path, opts),
  coverUrl: (u) => coverUrl(u),
  current: () => state.queue[state.index] || null,
  // 让唱片店的 8-bit 合成也走同一个 analyser：菜单栏频谱才不会是死的
  audio: () => { ensureAudioGraph(); return audioCtx ? { ctx: audioCtx, analyser } : null; },

  /* ---------- v2 回听闭环：所有「回看」动作的唯一出口 ----------
     墙 / 年鉴 / 去年今天 / 今日一曲都走这里，队列里带来源角标，
     取不到地址沿用已有的自动跳过，不打断回放。 */
  replay: (params, label) => replayTracks(params, label),
  queue: () => state.queue.slice(),
  toast: (msg, warn) => toast(msg, warn),
  flashTray: (ms) => { trayFlashUntil = Date.now() + (ms || 900); },
  queueGen: () => queueGen,
};

/* 事件流里只存了歌曲的基本信息（QQ 的 mid 之类播放字段不落库）。
   先按原样开播，再后台把缺字段的条目悄悄换成可播版本——不打断正在听的那首。 */
async function resolveReplayTracks(list, gen) {
  const norm = (v) => String(v || '').toLowerCase().replace(/[\s·・（）()「」『』\[\]-]/g, '');
  const same = (a, b) => norm(a.name) === norm(b.name);
  const need = (t) => !t.id || (t.provider === 'qq' && !t.mid) || (t.provider === 'xy' && !t.epid && t.isPodcast);
  const jobs = list.map((t, i) => ({ t, i })).filter(({ t }) => need(t));
  for (let k = 0; k < jobs.length; k += 4) {
    if (gen !== queueGen) return;
    await Promise.all(jobs.slice(k, k + 4).map(async ({ t, i }) => {
      try {
        const kw = `${t.name} ${t.artist || ''}`.trim();
        const r = await api(`/api/unified/search?keywords=${encodeURIComponent(kw)}&limit=6`);
        const items = (r && r.songs) || [];
        const pick = items.find((s) => same(s, t) && String(s.artist || '').includes(String(t.artist || '').split(/[\/,、&]/)[0]))
          || items.find((s) => same(s, t)) || items[0];
        if (!pick || gen !== queueGen) return;
        const cur = state.queue[i];
        if (!cur || !same(cur, t)) return;
        state.queue[i] = Object.assign({}, pick, {
          ewSource: cur.ewSource, plays: cur.plays, ewReplay: true,
        });
      } catch { /* 补不到就留着原记录，播放失败会自动跳下一首 */ }
    }));
    if (gen !== queueGen) return;
    renderQueue();
  }
}

async function replayTracks(params, label) {
  const key = encodeURIComponent((window.Taste && Taste.getSyncKey && Taste.getSyncKey()) || '');
  const qs = new URLSearchParams(params || {}).toString();
  let r;
  try { r = await api(`/api/taste/replay?syncKey=${key}&${qs}`); }
  catch (e) { toast('回听没取到：' + (e && e.message ? e.message : '服务不可用'), true); return null; }
  if (!r || !r.tracks || !r.tracks.length) {
    toast('这段时间还没有听歌记录 · 先去听一首');
    return r;
  }
  const list = r.tracks.map((t) => Object.assign({}, t, { ewReplay: true }));
  window.EW.play(list, 0);
  const gen = queueGen;
  toast(`${label || '那段时间'} · ${list.length} 首已加入队列`);
  document.dispatchEvent(new CustomEvent('ew:replay', { detail: { label, count: list.length } }));
  resolveReplayTracks(list, gen);
  return r;
}

/* ---------- 页面切换（桌面顶栏 + 移动 tabbar） ---------- */
function go(page) {
  document.querySelectorAll('#tabbar .tab').forEach(x => x.classList.toggle('cur', x.dataset.page === page));
  document.querySelectorAll('.page').forEach(el => { el.hidden = el.id !== page; });
  if (page === 'page-search') openSearchDrop(); else closeSearchDrop();
  document.dispatchEvent(new CustomEvent('ew:page', { detail: page }));
}
document.querySelectorAll('#tabbar .tab').forEach(t => t.addEventListener('click', () => go(t.dataset.page)));
$('nav-home').addEventListener('click', () => go('page-discover'));
$('nav-mine').addEventListener('click', () => go('page-mine'));

/* ---------- 搜索浮层 ---------- */
function openSearchDrop() {
  const d = $('page-search');
  if (d.hidden) { d.hidden = false; requestAnimationFrame(() => d.classList.add('show')); }
  $('search-input').focus();
}
function closeSearchDrop() {
  const d = $('page-search');
  if (d.hidden) return;
  d.classList.remove('show');
  setTimeout(() => { d.hidden = true; }, 240);
}
$('search-pill').addEventListener('click', () => { openSearchDrop(); $('search-input').focus(); });
document.addEventListener('click', (e) => {
  const d = $('page-search');
  if (d.hidden || isMobile()) return;
  if (!d.contains(e.target) && !$('search-pill').contains(e.target)) closeSearchDrop();
});
function isMobile() { return matchMedia('(max-width: 899px)').matches; }

/* ---------- 氛围视觉 ---------- */
const canvas = $('ambient');
const ctx = canvas.getContext('2d');
let motes = [];
function resizeCanvas() {
  canvas.width = innerWidth * devicePixelRatio; canvas.height = innerHeight * devicePixelRatio;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  motes = Array.from({ length: 46 }, () => ({
    x: Math.random() * innerWidth, y: Math.random() * innerHeight,
    r: 1 + Math.random() * 2.6, vx: (Math.random() - .5) * .22, vy: -(0.12 + Math.random() * .3),
    a: .08 + Math.random() * .3,
  }));
}
addEventListener('resize', resizeCanvas); resizeCanvas();
function drawAmbient(t) {
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  const beat = state.playing ? (state.level || (Math.sin(t / 900) * .5 + .5)) : 0;
  for (const m of motes) {
    m.x += m.vx; m.y += m.vy;
    if (m.y < -10) { m.y = innerHeight + 10; m.x = Math.random() * innerWidth; }
    if (m.x < -10) m.x = innerWidth + 10;
    if (m.x > innerWidth + 10) m.x = -10;
    const alpha = m.a * (state.playing ? .8 + beat * .9 : .7);
    const rr = m.r * (4 + beat * 3);
    const g = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, rr);
    g.addColorStop(0, `rgba(230,176,106,${alpha})`);
    g.addColorStop(1, 'rgba(230,176,106,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(m.x, m.y, rr, 0, 7); ctx.fill();
  }
  requestAnimationFrame(drawAmbient);
}
requestAnimationFrame(drawAmbient);

/* ---------- 墨染场：封面取色 → 水墨晕染粒子 ---------- */
const inkStage = $('stage');
const inkCanvas = $('ink');
const inkCtx = inkCanvas.getContext('2d');
/* main/sub/glow 供墨晕画布忠实呈现封面色；acc/accGlow 供 UI 强调色，
   始终以琥珀为底并保住明度，避免封面过暗时按钮、歌词、光圈一起发灰 */
const INK_BASE = {
  main: [230, 176, 106], sub: [143, 184, 174], glow: [242, 201, 138],
  acc: [230, 176, 106], accGlow: [242, 201, 138],
};
const inkClone = (p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, [...v]]));
let inkCur = inkClone(INK_BASE);       // 当前色（逐帧缓动，换歌不跳色）
let inkTarget = inkClone(INK_BASE);    // 封面目标色
const inkCss = { glow: '242,201,138' };
let inkBlobs = [], inkSpecks = [], inkFrame = 0;

function resizeInk() {
  const w = inkStage.clientWidth || innerWidth;
  const h = inkStage.clientHeight || innerHeight;
  // 低分辨率绘制 + CSS 模糊 = 柔和水墨边缘，同时省 GPU
  inkCanvas.width = Math.max(1, Math.round(w * .38));
  inkCanvas.height = Math.max(1, Math.round(h * .38));
  inkBlobs = Array.from({ length: 14 }, (_, i) => ({
    x: Math.random(), y: Math.random(),
    r: .13 + Math.random() * .26,
    vx: (Math.random() - .5) * .00018,
    vy: -(0.00005 + Math.random() * .00013),
    a: .10 + Math.random() * .16,
    c: i % 4 === 0 ? 'sub' : 'main',
    ph: Math.random() * 6.283,
  }));
  inkSpecks = Array.from({ length: 38 }, () => ({
    x: Math.random(), y: Math.random(),
    r: .0018 + Math.random() * .004,
    vx: (Math.random() - .5) * .00022,
    vy: -(0.0001 + Math.random() * .00028),
    a: .12 + Math.random() * .32,
    ph: Math.random() * 6.283,
  }));
}
function ensureInkSize() {
  if (inkStage.hidden) return;
  const w = Math.max(1, Math.round((inkStage.clientWidth || innerWidth) * .38));
  const h = Math.max(1, Math.round((inkStage.clientHeight || innerHeight) * .38));
  if (inkCanvas.width !== w || inkCanvas.height !== h) resizeInk();
}
addEventListener('resize', ensureInkSize);

function drawInk(t) {
  requestAnimationFrame(drawInk);
  if (!inkCanvas.width) resizeInk();
  if (inkStage.hidden || document.hidden) return;
  // 换歌时颜色缓动过渡
  for (const k in inkCur) {
    for (let i = 0; i < 3; i++) inkCur[k][i] += (inkTarget[k][i] - inkCur[k][i]) * .05;
  }
  if (++inkFrame % 4 === 0) {
    inkStage.style.setProperty('--ink-rgb', inkCur.acc.map(v => Math.round(v)).join(','));
    inkStage.style.setProperty('--ink-glow-rgb', inkCur.accGlow.map(v => Math.round(v)).join(','));
    inkCss.glow = inkCur.accGlow.map(v => Math.round(v)).join(',');
  }
  const W = inkCanvas.width, H = inkCanvas.height;
  const beat = state.playing ? (state.level || 0) : 0;
  inkCtx.clearRect(0, 0, W, H);
  inkCtx.globalCompositeOperation = 'screen';
  // 大墨晕：缓慢上浮、正弦呼吸、随节拍舒张
  for (const b of inkBlobs) {
    b.x += b.vx; b.y += b.vy;
    if (b.y < -.4) { b.y = 1.4; b.x = Math.random(); }
    if (b.x < -.4) b.x = 1.4;
    if (b.x > 1.4) b.x = -.4;
    const breathe = 1 + Math.sin(t / 2700 + b.ph) * .13 + beat * .09;
    const cx = b.x * W, cy = b.y * H, r = b.r * W * breathe;
    const c = inkCur[b.c];
    const rgb = `${c[0] | 0},${c[1] | 0},${c[2] | 0}`;
    const alpha = b.a * (state.playing ? .9 + beat * .55 : .72);
    const g = inkCtx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, `rgba(${rgb},${alpha})`);
    g.addColorStop(.42, `rgba(${rgb},${alpha * .4})`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    inkCtx.fillStyle = g;
    inkCtx.beginPath(); inkCtx.arc(cx, cy, r, 0, 6.2832); inkCtx.fill();
  }
  // 细墨点：浮尘般的微光
  const gc = inkCur.accGlow, grgb = `${gc[0] | 0},${gc[1] | 0},${gc[2] | 0}`;
  for (const s of inkSpecks) {
    s.x += s.vx; s.y += s.vy;
    if (s.y < -.02) { s.y = 1.02; s.x = Math.random(); }
    const tw = .55 + Math.sin(t / 1500 + s.ph) * .45;
    inkCtx.fillStyle = `rgba(${grgb},${s.a * tw})`;
    inkCtx.beginPath();
    inkCtx.arc(s.x * W, s.y * H, Math.max(.8, s.r * W * (1 + beat * .4)), 0, 6.2832);
    inkCtx.fill();
  }
  inkCtx.globalCompositeOperation = 'source-over';
}
requestAnimationFrame(drawInk);

/* 从封面代理图提取主色（同源，可读像素），混入琥珀以保持国风墨色基调 */
function paintFromCover(src) {
  if (!src) { inkTarget = inkClone(INK_BASE); return; }
  const img = new Image();
  img.onload = () => {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 20;
      const cx = c.getContext('2d', { willReadFrequently: true });
      cx.drawImage(img, 0, 0, 20, 20);
      const d = cx.getImageData(0, 0, 20, 20).data;
      let rs = 0, gs = 0, bs = 0, n = 0, best = null, bestScore = -1;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        if (d[i + 3] < 40) continue;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const lum = r * .299 + g * .587 + b * .114;
        if (lum < 20 || lum > 238) continue;
        rs += r; gs += g; bs += b; n++;
        const score = (mx - mn) * (1 - Math.abs(lum - 150) / 150);
        if (score > bestScore) { bestScore = score; best = [r, g, b]; }
      }
      if (!n) return;
      let main = [rs / n, gs / n, bs / n].map((v, i) => v * .6 + INK_BASE.main[i] * .4);
      const lum = main[0] * .299 + main[1] * .587 + main[2] * .114;
      if (lum > 178) main = main.map(v => v * 178 / lum);
      else if (lum < 60) main = main.map(v => Math.min(255, v * 1.25));
      const glow = main.map((v, i) => Math.min(255, v * .5 + INK_BASE.glow[i] * .5));
      const sub = best
        ? best.map((v, i) => v * .58 + INK_BASE.sub[i] * .42)
        : [...INK_BASE.sub];
      // UI 强调色：七成琥珀 + 三成封面，明度不足则整体提亮，保证按钮与歌词始终点睛
      let acc = main.map((v, i) => v * .3 + INK_BASE.main[i] * .7);
      const alum = acc[0] * .299 + acc[1] * .587 + acc[2] * .114;
      if (alum < 175) acc = acc.map(v => Math.min(255, v * 175 / alum));
      const accGlow = acc.map((v, i) => Math.min(255, v * .45 + INK_BASE.glow[i] * .55));
      inkTarget = { main, sub, glow, acc, accGlow };
    } catch (e) { /* 图片不可读时保持当前色 */ }
  };
  img.src = src;
}

/* ---------- 频谱可视化（Web Audio，复刻原版 02-visual/03-beat） ---------- */
let audioCtx = null, analyser = null, freqData = null;
function ensureAudioGraph() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaElementSource(audio);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = .8;
    // 默认的 -100/-30 dB 太窄：流行歌一放就全线顶到 255，频谱变成一堵墙
    analyser.minDecibels = -82;
    analyser.maxDecibels = -12;
    freqData = new Uint8Array(analyser.frequencyBinCount);
    src.connect(analyser);
    analyser.connect(audioCtx.destination);
  } catch (e) { console.warn('频谱不可用', e); }
}
const spCanvas = $('spectrum');
const spCtx = spCanvas.getContext('2d');
let lowAvg = 0;
/* 菜单栏频谱：48 根柱子压成 8 段交给桌面端（浏览器里没人读，赋值开销可忽略）
   分频用对数边界：线性切分时能量全挤在低频，菜单栏上只会看到左边两根在跳 */
const MENU_BANDS = 8;
const BAND_EDGES = [1, 2, 4, 7, 12, 20, 34, 56, 96];
const BAND_GAIN = [1, 1.05, 1.15, 1.25, 1.35, 1.45, 1.6, 2];
const menuBands = new Float32Array(MENU_BANDS);
function publishMenuBands(on) {
  window.__ewSpectrum = on ? Array.from(menuBands) : null;
}
function readMenuBands() {
  for (let b = 0; b < MENU_BANDS; b++) {
    const from = BAND_EDGES[b], to = Math.min(freqData.length, BAND_EDGES[b + 1]);
    let acc = 0, n = 0;
    for (let k = from; k < to; k++) { acc += freqData[k]; n++; }
    const avg = n ? acc / n / 255 : 0;
    // 高频天然更弱，按段补一点增益，整条才像在跳而不是只有左半边
    const v = Math.min(1, avg * BAND_GAIN[b]);
    menuBands[b] = menuBands[b] * .5 + v * .5;
  }
}
function drawSpectrum() {
  requestAnimationFrame(drawSpectrum);
  if (!spCanvas.width) resizeSpectrum();
  spCtx.clearRect(0, 0, spCanvas.width, spCanvas.height);
  // 唱片店的 8-bit 片段也接到同一个 analyser 上，播放时频谱照样要动
  const live = state.playing || !!window.__ewExternalAudio;
  // 成就解锁：菜单栏图标闪一下（暂停时也要能闪），不必进页面才知道
  const flashing = Date.now() < trayFlashUntil;
  if (flashing) window.__ewSpectrum = new Array(MENU_BANDS).fill(1);
  if (!analyser || !live) { state.level = 0; if (!flashing) publishMenuBands(false); return; }
  analyser.getByteFrequencyData(freqData);
  const bars = 48, step = Math.floor(freqData.length / bars);
  const w = spCanvas.width / bars;
  let sum = 0;
  for (let i = 0; i < bars; i++) {
    let v = 0;
    for (let k = 0; k < step; k++) v += freqData[i * step + k];
    v = v / step / 255;
    sum += v;
    const h = Math.max(2, v * spCanvas.height * .9);
    const grad = spCtx.createLinearGradient(0, spCanvas.height, 0, spCanvas.height - h);
    grad.addColorStop(0, `rgba(${inkCss.glow},.15)`);
    grad.addColorStop(1, `rgba(${inkCss.glow},${.25 + v * .6})`);
    spCtx.fillStyle = grad;
    spCtx.fillRect(i * w + w * .18, spCanvas.height - h, w * .64, h);
  }
  readMenuBands();
  if (!flashing) publishMenuBands(true);
  lowAvg = lowAvg * .8 + (sum / bars) * .2;
  state.level = Math.min(1.4, lowAvg * 2.2);
  document.documentElement.style.setProperty('--beat', state.level.toFixed(3));
}
function resizeSpectrum() {
  if (!spCanvas.offsetParent) return;
  spCanvas.width = spCanvas.clientWidth * devicePixelRatio;
  spCanvas.height = spCanvas.clientHeight * devicePixelRatio;
}
addEventListener('resize', resizeSpectrum);
requestAnimationFrame(drawSpectrum);

/* ---------- 登录态 ---------- */
async function refreshLoginStatus() {
  try {
    const r = await api('/api/login/status');
    if (r.loggedIn) {
      state.user = r;
      $('topbar-user').hidden = false; $('login-btn').hidden = true;
      $('logout-btn').hidden = false;
      $('user-name').textContent = r.nickname || '';
      if (r.avatar) $('user-avatar').src = r.avatar;
      $('mine-user').hidden = false; $('mine-login-tip').hidden = true;
      $('mine-name').textContent = r.nickname || '';
      $('mine-vip').textContent = r.vipLabel && r.vipLabel !== '无VIP' ? r.vipLabel : '普通听众';
      if (r.avatar) $('mine-avatar').src = r.avatar;
      loadMyPlaylists();
    } else {
      state.user = null;
      $('topbar-user').hidden = true; $('login-btn').hidden = false;
      $('logout-btn').hidden = true;
      $('mine-user').hidden = true; $('mine-login-tip').hidden = false;
    }
  } catch { $('login-btn').hidden = false; }
  // 无论网易云是否登录，都要刷新四平台总览并重新汇聚首页/曲库
  refreshAccountStatus();
}
function logout() {
  if (!confirm('退出登录并清除本机 cookie？')) return;
  api('/api/logout').then(refreshLoginStatus);
}

/* ====================================================================
   统一音源层（前端）
   一次连接 → 状态 / 首页 / 曲库 / 搜索 / 播放换源全部覆盖四个平台。
   老服务没有 /api/unified/* 时给出可读降级提示，不阻断原有功能。
   ==================================================================== */
let lastConnectedKey = '';

async function refreshAccountStatus(force) {
  let d;
  try {
    d = await api('/api/unified/status');
    if (!d || !Array.isArray(d.providers)) throw new Error('统一音源接口返回异常');
  } catch (e) {
    d = {
      degraded: true, connected: 0, total: 4, error: e.message,
      providers: Object.keys(PROVIDER_LABEL).filter(k => k !== 'all').map(id => ({
        id, short: PROVIDER_LABEL[id], label: PROVIDER_LABEL[id], glyph: '源',
        loggedIn: false, capabilities: [], hint: '服务未启用统一音源接口',
      })),
    };
  }
  state.accountStatus = d;
  renderAccountButton(d);
  renderSourceBar(d);
  renderAccountOverview(d);
  applyLoginPanels();
  syncLoginEggEvents(d);
  if (d.degraded) {
    $('unified-section').hidden = false;
    $('unified-home').innerHTML = '<div class="u-empty">当前服务未启用统一音源接口，请升级本地 server.js 后刷新。' + '</div>';
    $('unified-library').innerHTML = '<div class="u-empty">同上，需本地服务支持。</div>';
    return;
  }
  const key = d.providers.map(p => p.id + ':' + (p.loggedIn ? 1 : 0)).join(',');
  if (force || key !== lastConnectedKey) {
    lastConnectedKey = key;
    loadUnifiedHome();
    loadUnifiedLibrary();
  }
}
function renderAccountButton(d) {
  const btn = $('account-btn'); if (!btn) return;
  $('account-count').textContent = d.degraded ? '—' : `${d.connected}/${d.total}`;
  btn.classList.toggle('all-connected', !d.degraded && d.connected === d.total);
  btn.classList.toggle('degraded', !!d.degraded);
  btn.title = d.degraded ? ('统一音源接口不可用：' + (d.error || ''))
    : d.providers.map(p => `${p.label}：${p.loggedIn ? '已连接' : '未连接'}`).join('\n');
}
function renderSourceBar(d) {
  const bar = $('unified-bar'); if (!bar) return;
  bar.innerHTML = '';
  d.providers.forEach(p => {
    const el = document.createElement('button');
    el.className = 'unified-pill ' + (p.loggedIn ? 'on' : 'off');
    el.innerHTML = `<i>${escapeHtml(p.glyph || '源')}</i><span>${escapeHtml(p.short)}</span><em>${p.loggedIn ? '已连接' : '去连接'}</em>`;
    el.title = p.loggedIn ? (p.nickname || p.label) : (p.hint || '点此连接');
    el.onclick = () => openLogin(p.id);
    bar.appendChild(el);
  });
}
function renderAccountOverview(d) {
  const box = $('account-overview'), note = $('account-overview-note');
  if (!box || !note || !d || !Array.isArray(d.providers)) return;
  box.innerHTML = '';
  const hint = d.degraded ? '统一音源接口不可用：' + (d.error || '') : '';
  d.providers.forEach(p => {
    const card = document.createElement('div');
    card.className = 'acc-card ' + (p.loggedIn ? 'on' : 'off');
    const who = p.loggedIn ? (p.nickname || p.userId || p.detail || '已连接') : (p.error || p.hint || '连接后可解锁该平台内容');
    card.innerHTML = `
      <div class="acc-head"><span class="acc-g">${escapeHtml(p.glyph || '源')}</span>
        <div class="acc-id"><b>${escapeHtml(p.label)}</b><small>${escapeHtml(String(who))}</small></div>
        <span class="acc-state">${p.loggedIn ? '已连接' : '待连接'}</span></div>
      <div class="acc-caps">${(p.capabilities || []).length
        ? p.capabilities.map(c => `<span>${escapeHtml(c)}</span>`).join('')
        : '<span>连接后解锁</span>'}</div>
      <div class="acc-login">${p.loginReady === false
        ? '⚠ ' + escapeHtml(p.loginNote || p.error || '当前环境无可用登录通道')
        : escapeHtml((p.loginMethods || []).join(' / ') || p.hint || '')}</div>
      <button class="acc-go brush-btn">${p.loggedIn ? '管理' : '连接'}</button>`;
    card.querySelector('.acc-go').onclick = () => switchLoginTab(p.id);
    box.appendChild(card);
  });
  const left = d.degraded ? 0 : (d.total - d.connected);
  note.textContent = hint || (left
    ? `还有 ${left} 个音源未连接 · 授权后内容自动并入首页、搜索与曲库`
    : '四个音源已全部连接 · 全站内容自动汇聚');
  const next = $('account-connect-next');
  if (next) { next.disabled = !left; next.textContent = left ? '连接下一个音源' : '已全部连接'; }
}
function connectNextSource() {
  const d = state.accountStatus;
  if (!d || d.degraded) return;
  const next = d.providers.find(p => !p.loggedIn);
  if (next) switchLoginTab(next.id);
}

/* ---------- 统一首页 ---------- */
async function loadUnifiedHome() {
  const box = $('unified-home'), sec = $('unified-section');
  if (!box || !sec) return;
  box.innerHTML = '<div class="u-loading">正在汇聚各平台音源……</div>';
  sec.hidden = false;
  try {
    const d = await api('/api/unified/home');
    const all = d.sections || [];
    const filled = all.filter(s => (s.items || []).length);
    const failed = all.filter(s => !(s.items || []).length && s.status === 'error');
    if (!filled.length) {
      box.innerHTML = '<div class="u-empty">各平台暂未返回内容，先连接音源或点「重新汇聚」再试。</div>';
      return;
    }
    box.innerHTML = '';
    // 两行 × 两列紧凑轨道：四平台同屏，每块只占一条横滑
    const grid = document.createElement('div'); grid.className = 'u-grid';
    filled.forEach((s, i) => grid.appendChild(unifiedSectionEl(s, i)));
    box.appendChild(grid);
    requestAnimationFrame(syncUnifiedArrows);
    // 只有真失败才单独提示；未登录的音源由上方状态条负责，不重复占位
    if (failed.length) {
      const tip = document.createElement('div'); tip.className = 'u-fail';
      tip.textContent = failed.map(s => `${s.short}：${s.message || '拉取失败'}`).join(' · ');
      box.appendChild(tip);
    }
  } catch (e) { box.innerHTML = `<div class="u-empty">统一汇聚暂不可用：${escapeHtml(e.message)}</div>`; }
}
function unifiedSectionEl(s, i) {
  const wrap = document.createElement('div');
  wrap.className = 'u-sec';
  wrap.style.setProperty('--i', String(Math.min(i, 8)));
  const head = document.createElement('div');
  head.className = 'u-head';
  head.innerHTML = `<span class="u-badge ${escapeHtml(s.status)}">${escapeHtml(s.short)}</span>
    <div class="u-title"><b>${escapeHtml(s.title)}</b><small>${escapeHtml(s.subtitle || '')}</small></div>
    <span class="u-count">${(s.items || []).length} 条</span>
    <button class="u-arrow" type="button" aria-label="向右翻看">›</button>`;
  wrap.appendChild(head);
  const items = s.items || [];
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'u-empty';
    empty.textContent = s.message || '暂无内容';
    if (s.action) {
      const b = document.createElement('button');
      b.className = 'brush-btn solid'; b.textContent = s.action.label;
      b.onclick = () => openLogin(s.action.tab);
      empty.appendChild(b);
    }
    wrap.appendChild(empty);
    return wrap;
  }
  const rail = document.createElement('div'); rail.className = 'rail u-rail';
  rail.addEventListener('scroll', syncUnifiedArrows, { passive: true });
  const playable = items.filter(x => !(x.isPodcast || x.type === 'podcast' || x.type === 'playlist'));
  items.forEach((item, j) => {
    const el = document.createElement('div');
    el.className = 'rail-card';
    el.style.setProperty('--i', String(Math.min(j, 12)));
    el.innerHTML = `<img src="${coverUrl(item.cover) || 'icon.svg'}" loading="lazy" alt="">
      <div class="rc-name">${escapeHtml(item.name)}</div>
      <div class="rc-sub">${escapeHtml(item.artist || item.creator || s.short)}</div>`;
    el.onclick = () => {
      if (item.type === 'playlist') openUnifiedPlaylist(item.provider || s.provider, item.id, item.name);
      else if (item.isPodcast || item.type === 'podcast') openXYPodcast(item.pid || item.id);
      else { state.queue = playable.slice(); renderQueue(); playIndex(playable.indexOf(item)); }
    };
    rail.appendChild(el);
  });
  wrap.appendChild(rail);
  const arrow = head.querySelector('.u-arrow');
  if (arrow) {
    arrow.onclick = (e) => {
      e.stopPropagation();
      const max = rail.scrollWidth - rail.clientWidth;
      if (max <= 4) return;
      rail.scrollBy({ left: rail.scrollLeft >= max - 6 ? -max : Math.round(rail.clientWidth * 0.85), behavior: 'smooth' });
    };
  }
  return wrap;
}

/* 轨道溢出才显示翻页箭头；右侧还有内容时加一层渐隐，避免卡片被硬切 */
function syncUnifiedArrows() {
  document.querySelectorAll('#unified-home .u-sec').forEach((w) => {
    const rail = w.querySelector('.u-rail');
    if (!rail) return;
    const max = rail.scrollWidth - rail.clientWidth;
    const overflow = max > 2;
    const atEnd = rail.scrollLeft >= max - 2;
    w.classList.toggle('can-scroll', overflow && !atEnd);
    w.classList.toggle('can-scroll-back', overflow && rail.scrollLeft > 2);
    const arrow = w.querySelector('.u-arrow');
    if (arrow) arrow.hidden = !overflow;
  });
}
window.addEventListener('resize', () => syncUnifiedArrows());

/* ---------- 统一曲库 ---------- */
async function loadUnifiedLibrary() {
  const box = $('unified-library'); if (!box) return;
  box.innerHTML = '<div class="u-loading">正在同步各方曲库……</div>';
  try {
    const d = await api('/api/unified/library');
    box.innerHTML = '';
    (d.groups || []).forEach(g => {
      const sec = document.createElement('div'); sec.className = 'u-lib';
      sec.innerHTML = `<div class="u-lib-head"><span class="u-badge">${escapeHtml(g.short)}</span><b>${escapeHtml(g.label)}</b><em>${(g.items || []).length}</em></div>`;
      const items = g.items || [];
      if (!items.length) {
        const e = document.createElement('div'); e.className = 'u-empty';
        e.textContent = g.message || '暂无内容';
        if (g.action) {
          const b = document.createElement('button');
          b.className = 'brush-btn solid'; b.textContent = g.action.label;
          b.onclick = () => openLogin(g.action.tab);
          e.appendChild(b);
        }
        sec.appendChild(e);
      } else {
        items.forEach(p => {
          const row = document.createElement('div'); row.className = 'pl-row';
          row.innerHTML = `<img src="${coverUrl(p.cover) || 'icon.svg'}" loading="lazy" alt="">
            <div style="flex:1;min-width:0"><div class="pr-name">${escapeHtml(p.name || '')}</div>
            <div class="pr-sub">${escapeHtml(g.short)} · ${p.trackCount || p.episodesCount || 0} 首</div></div>`;
          row.onclick = () => p.type === 'podcast'
            ? openXYPodcast(p.pid || p.id)
            : openUnifiedPlaylist(g.provider, p.id, p.name);
          sec.appendChild(row);
        });
      }
      box.appendChild(sec);
    });
  } catch (e) { box.innerHTML = `<div class="u-empty">曲库同步失败：${escapeHtml(e.message)}</div>`; }
}

/* ---------- 统一歌单详情（任意平台） ---------- */
async function openUnifiedPlaylist(provider, id, name) {
  $('pl-detail').hidden = false;
  requestAnimationFrame(() => $('pl-detail').classList.add('show'));
  $('pl-tracks').innerHTML = '<div class="song"><div class="meta"><div class="name">正在取曲……</div></div></div>';
  try {
    const d = await api(`/api/unified/playlist?provider=${encodeURIComponent(provider)}&id=${encodeURIComponent(id)}`);
    const pl = d.playlist || {}, tracks = (d.tracks || []).map(s => Object.assign({}, s, { provider: s.provider || provider, source: s.source || provider }));
    state.currentPl = tracks;
    $('pl-cover').src = coverUrl(pl.cover) || 'icon.svg';
    $('pl-name').textContent = pl.name || name || '曲单';
    $('pl-count').textContent = `${pl.trackCount || tracks.length} 首 · ${PROVIDER_LABEL[provider] || provider}`;
    $('pl-playall').onclick = () => { state.queue = tracks.slice(); renderQueue(); closePlDetail(); playIndex(0); };
    const box = $('pl-tracks'); box.innerHTML = '';
    tracks.forEach((s, i) => box.appendChild(songEl(s, i, i + 1)));
    if (!tracks.length) box.innerHTML = '<div class="song"><div class="meta"><div class="name">该曲单暂不可读，可能需要重新连接这个音源</div></div></div>';
  } catch (e) {
    $('pl-tracks').innerHTML = `<div class="song"><div class="meta"><div class="name">取曲失败：${escapeHtml(e.message)}</div></div></div>`;
  }
}

/* ---------- 全域搜索结果：逐平台回报 ---------- */
function renderSearchSources(sources) {
  const box = $('search-source-summary'); if (!box) return;
  state.unifiedSources = sources;
  box.hidden = false; box.innerHTML = '';
  sources.forEach(s => {
    const el = document.createElement('span');
    const st = s.status;
    el.className = 'ss-pill ' + (st === 'need_login' ? 'need' : st === 'error' ? 'err' : st === 'public' ? 'public' : 'ok');
    const txt = st === 'need_login' ? '待登录' : st === 'error' ? '暂不可用' : `${s.count} 条`;
    el.innerHTML = `<b>${escapeHtml(s.short)}</b><em>${escapeHtml(txt)}</em>`;
    if (st === 'need_login' || st === 'error') {
      el.classList.add('clickable');
      el.title = s.message || '点此连接该音源';
      el.onclick = () => openLogin(s.id);
    }
    box.appendChild(el);
  });
}
async function doUnifiedSearch(kw, append) {
  if (!append) {
    state.unifiedPage = 0;
    $('results').innerHTML = '<div class="song"><div class="meta"><div class="name">正在四平台同时寻曲……</div></div></div>';
  }
  try {
    const d = await api(`/api/unified/search?keywords=${encodeURIComponent(kw)}&limit=12&page=${state.unifiedPage}`);
    renderSearchSources(d.sources || []);
    const songs = d.songs || [];
    if (!append) { state.queue = []; $('results').innerHTML = ''; }
    const start = state.queue.length;
    state.queue.push(...songs);
    songs.forEach((s, i) => $('results').appendChild(songEl(s, start + i)));
    state.unifiedPage += 1;
    $('more-btn-wrap').hidden = !d.hasMore;
    renderQueue();
    if (!state.queue.length) $('results').innerHTML = '<div class="song"><div class="meta"><div class="name">四个平台都没找到，换个关键词试试</div></div></div>';
  } catch (e) {
    $('results').innerHTML = `<div class="song"><div class="meta"><div class="name">全域寻曲失败：${escapeHtml(e.message)}</div></div></div>`;
  }
}

/* ---------- 发现页（bento） ---------- */
function setQuote() { $('poem-line').textContent = POEMS[Math.floor(Math.random() * POEMS.length)]; }
function updateContinueCard() {
  const saved = state.queue[state.index];
  const daily = state.daily || [];
  if (saved) {
    $('bc-kicker').textContent = 'CONTINUE · 继续听';
    $('hero-cover').src = coverUrl(saved.cover) || 'icon.svg';
    $('hero-name').textContent = saved.name;
    $('hero-artist').textContent = saved.artist + ' · 上次听到这里';
    $('hero-play').onclick = (e) => { e.stopPropagation(); playIndex(state.index); };
  } else if (daily.length) {
    const first = daily[0];
    $('bc-kicker').textContent = 'DAILY · 今日推荐';
    $('hero-cover').src = coverUrl(first.cover) || 'icon.svg';
    $('hero-name').textContent = first.name;
    $('hero-artist').textContent = first.artist + (first.album ? ' · ' + first.album : '');
    $('hero-play').onclick = (e) => { e.stopPropagation(); state.queue = daily.slice(); renderQueue(); playIndex(0); };
  } else return;
  $('bento-continue').onclick = () => $('hero-play').click();
  tintHomeCover($('hero-cover').src);
}
function renderNextUp() {
  const next = state.queue[state.index + 1] || state.queue[0];
  if (!next) { $('nu-name').textContent = '队列里还没有歌曲'; $('nu-sub').textContent = '点开一首试试耳朵'; $('nu-cover').style.backgroundImage = ''; return; }
  $('nu-name').textContent = next.name;
  $('nu-sub').textContent = next.artist + (state.queue.length > 1 ? ` · 共 ${state.queue.length} 首` : '');
  $('nu-cover').style.backgroundImage = next.cover ? `url(${coverUrl(next.cover)})` : '';
}
async function loadDiscover() {
  setQuote();
  try {
    const d = await api('/api/discover/home');
    const daily = d.dailySongs || [];
    state.daily = daily;
    updateContinueCard();
    if (daily.length) {
      $('daily-rail-section').hidden = false;
      const rail = $('daily-rail'); rail.innerHTML = '';
      daily.slice(0, 20).forEach((s, i) => {
        const el = document.createElement('div');
        el.className = 'rail-card';
        el.style.setProperty('--i', String(Math.min(i, 12)));
        el.innerHTML = `<img src="${coverUrl(s.cover)}" loading="lazy" alt=""><div class="rc-name">${escapeHtml(s.name)}</div><div class="rc-sub">${escapeHtml(s.artist)}</div>`;
        el.onclick = () => { state.queue = daily.slice(); renderQueue(); playIndex(daily.indexOf(s)); };
        rail.appendChild(el);
      });
    }
    const pls = d.playlists || [];
    if (pls.length) {
      $('pl-grid-section').hidden = false;
      const grid = $('pl-grid'); grid.innerHTML = '';
      pls.slice(0, 6).forEach((p, i) => {
        const el = document.createElement('div');
        el.className = 'pl-cell';
        el.style.setProperty('--i', String(i));
        el.innerHTML = `<img src="${coverUrl(p.cover)}" loading="lazy" alt=""><div class="pc-name">${escapeHtml(p.name)}</div><div class="pc-sub">${escapeHtml(p.tag || '')} · ${p.trackCount || 0}首</div>`;
        el.onclick = () => openPlaylist(p.id);
        grid.appendChild(el);
      });
    }
  } catch (e) { console.warn('discover', e); }
}
/* bento 交互 */
$('poem-shuffle').addEventListener('click', setQuote);
$('daily-play').addEventListener('click', () => {
  const daily = state.daily || [];
  if (!daily.length) return;
  if (state.queue[0] && state.queue[0].__daily) return playIndex(0);
  state.queue = daily.slice(); state.queue.forEach(s => s.__daily = true);
  renderQueue(); playIndex(0);
});
$('hero-shuffle').addEventListener('click', (e) => {
  e.stopPropagation();
  const daily = state.daily || [];
  if (!daily.length) return;
  state.queue = daily.slice(); renderQueue();
  playIndex(Math.floor(Math.random() * daily.length));
});
$('bento-daily').addEventListener('click', () => $('daily-play').click());
$('bento-library').addEventListener('click', () => go('page-mine'));
$('bento-recent').addEventListener('click', () => {
  if (state.queue.length) playIndex(state.index >= 0 ? state.index : 0);
});
$('bento-nextup').addEventListener('click', openQueue);

/* ---------- 歌单 ---------- */
async function loadMyPlaylists() {
  try {
    const d = await api('/api/user/playlists');
    const list = $('my-playlists'); list.innerHTML = '';
    const n = (d.playlists || []).length;
    $('lib-sub').textContent = n ? `${n} 张歌单 · 已同步` : '登录后同步歌单';
    (d.playlists || []).forEach(p => {
      const el = document.createElement('div');
      el.className = 'pl-row';
      el.innerHTML = `<img src="${coverUrl(p.cover)}" loading="lazy" alt=""><div style="flex:1;min-width:0"><div class="pr-name">${escapeHtml(p.name)}</div><div class="pr-sub">${p.trackCount} 首 · ${p.specialType === 5 ? '我的心头好' : escapeHtml(p.creator || '')}</div></div>`;
      el.onclick = () => openPlaylist(p.id);
      list.appendChild(el);
    });
  } catch (e) { console.warn('my playlists', e); }
}
async function openPlaylist(id) {
  $('pl-detail').hidden = false;
  requestAnimationFrame(() => $('pl-detail').classList.add('show'));
  $('pl-tracks').innerHTML = '<div class="song"><div class="meta"><div class="name">正在取曲……</div></div></div>';
  try {
    const d = await api(`/api/playlist/tracks?id=${id}&limit=50`);
    const pl = d.playlist || {}, tracks = d.tracks || [];
    state.currentPl = tracks;
    $('pl-cover').src = coverUrl(pl.cover);
    $('pl-name').textContent = pl.name || '曲单';
    $('pl-count').textContent = `${pl.trackCount || tracks.length} 首 · ${plural(pl.playCount || 0)} 次听过`;
    $('pl-playall').onclick = () => { state.queue = tracks.slice(); renderQueue(); closePlDetail(); playIndex(0); };
    const box = $('pl-tracks'); box.innerHTML = '';
    tracks.forEach((s, i) => box.appendChild(songEl(s, i, i + 1)));
  } catch (e) {
    $('pl-tracks').innerHTML = `<div class="song"><div class="meta"><div class="name">取曲失败：${escapeHtml(e.message)}</div></div></div>`;
  }
}
function closePlDetail() {
  $('pl-detail').classList.remove('show');
  setTimeout(() => { $('pl-detail').hidden = true; }, 380);
}
$('pl-back').addEventListener('click', closePlDetail);

/* ---------- 小宇宙播客详情 ---------- */
async function openXYPodcast(pid) {
  $('pl-detail').hidden = false;
  requestAnimationFrame(() => $('pl-detail').classList.add('show'));
  $('pl-tracks').innerHTML = '<div class="song"><div class="meta"><div class="name">正在取节目……</div></div></div>';
  try {
    const d = await api(`/api/xy/podcast?id=${pid}`);
    const p = d.podcast || {}, episodes = d.episodes || [];
    state.currentPl = episodes;
    $('pl-cover').src = coverUrl(p.cover);
    $('pl-name').textContent = p.name || '播客';
    $('pl-count').textContent = `小宇宙 · ${episodes.length}${d.total ? ' / ' + d.total : ''} 集 · ${p.artist || ''}`;
    $('pl-playall').onclick = () => { state.queue = episodes.slice(); renderQueue(); closePlDetail(); playIndex(0); };
    const box = $('pl-tracks'); box.innerHTML = '';
    episodes.forEach((s, i) => box.appendChild(songEl(s, i, i + 1)));
  } catch (e) {
    $('pl-tracks').innerHTML = `<div class="song"><div class="meta"><div class="name">取节目失败：${escapeHtml(e.message)}</div></div></div>`;
  }
}

/* ---------- 搜索 ---------- */
function getHist() { try { return JSON.parse(localStorage.getItem('ew_hist') || '[]'); } catch { return []; } }
function pushHist(kw) {
  let h = getHist().filter(x => x !== kw);
  h.unshift(kw); h = h.slice(0, 10);
  localStorage.setItem('ew_hist', JSON.stringify(h)); renderHist();
}
function renderHist() {
  const h = getHist();
  $('search-history-wrap').hidden = !h.length;
  const box = $('search-history'); box.innerHTML = '';
  h.forEach(kw => {
    const c = document.createElement('span');
    c.className = 'chip'; c.textContent = kw;
    c.onclick = () => { $('search-input').value = kw; doSearch(kw); };
    box.appendChild(c);
  });
}
$('hist-clear').addEventListener('click', () => { localStorage.removeItem('ew_hist'); renderHist(); });
$('search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); const kw = e.target.value.trim(); if (kw) { pushHist(kw); doSearch(kw); } }
});
/* ---------- 搜索平台切换 ---------- */
document.addEventListener('DOMContentLoaded', () => {
  $('src-tabs').querySelectorAll('.src-tab').forEach(btn => {
    btn.classList.toggle('cur', btn.dataset.src === state.provider);
    btn.addEventListener('click', () => {
      state.provider = btn.dataset.src;
      localStorage.setItem('ew_provider_v2', state.provider);
      btn.parentElement.querySelectorAll('.src-tab').forEach(b => b.classList.toggle('cur', b === btn));
      const kw = $('search-input').value.trim();
      if (kw) doSearch(kw);
    });
  });
});

async function doSearch(kw, append) {
  if (state.provider === 'all') return doUnifiedSearch(kw, append);
  $('search-source-summary').hidden = true;
  if (!append) { state.offset = 0; $('results').innerHTML = '<div class="song"><div class="meta"><div class="name">正在寻曲……</div></div></div>'; }
  try {
    const ep = state.provider === 'qq' ? '/api/qq/search'
      : state.provider === 'qishui' ? '/api/qishui/search'
      : state.provider === 'xy' ? '/api/xy/search'
      : '/api/search';
    const data = await api(`${ep}?keywords=${encodeURIComponent(kw)}&limit=20&offset=${state.offset}`);
    if (data.error === 'NEED_LOGIN') {
      const isXY = state.provider === 'xy';
      $('results').innerHTML = `<div class="song xy-need"><div class="meta"><div class="name">${isXY ? '小宇宙登录已失效' : '需要登录'}</div><div class="artist">${escapeHtml(data.message || '请先登录该平台')}</div></div>${isXY ? '<button class="brush-btn solid" id="results-login">去登录</button>' : ''}</div>`;
      if (isXY) $('results-login').onclick = () => openLogin('xy');
      $('more-btn-wrap').hidden = true;
      return;
    }
    const songs = data.songs || [];
    if (!append) { state.queue = []; $('results').innerHTML = ''; }
    const start = state.queue.length;
    state.queue.push(...songs);
    songs.forEach((s, i) => $('results').appendChild(songEl(s, start + i)));
    state.offset += songs.length;
    $('more-btn-wrap').hidden = songs.length < 20;
    renderQueue();
  } catch (e) {
    $('results').innerHTML = `<div class="song"><div class="meta"><div class="name">寻曲失败：${escapeHtml(e.message)}</div></div></div>`;
  }
}
$('more-btn').addEventListener('click', () => doSearch(state.keyword || $('search-input').value.trim(), true));

/* ---------- 取不到地址：就地跳过 ----------
   一首歌唱不出来（VIP / 版权 / 未登录 / 代理 502），不该把界面停在报错上。
   策略：先试一次换源（已有 _fallbackTried），换源也不成，直接往后放下一首；
   连续失败到上限就停下并说明原因，免得在一整批坏歌上空转。 */
const SKIP_LIMIT = 12;
const deadSet = new Set();
const deadKey = (s) => `${s.provider || 'netease'}:${s.id || s.mid || s.name}`;
const isDead = (s) => deadSet.has(deadKey(s));

/* 轻提示：跳歌这种事要让人看见，但别打断当前操作 */
let toastTimer = 0;
function toast(msg, warn) {
  if (!msg) return;
  let el = document.getElementById('ew-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ew-toast';
    el.className = 'ew-toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.toggle('warn', !!warn);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), warn ? 5200 : 2600);
}

/* 跳过时的下一首：随机模式随机换，其余按队列顺序；到底回卷——
   回卷不会死循环，因为 skipStreak 到上限就停 */
function nextAfterFail(from) {
  const n = state.queue.length;
  if (!n) return -1;
  if (state.mode === 'shuffle' && n > 1) {
    let t = from;
    for (let k = 0; k < 8 && t === from; k++) t = Math.floor(Math.random() * n);
    return t === from ? (from + 1) % n : t;
  }
  return (from + 1) % n;
}

/* 不可播要标清原因：VIP / 版权 / 未登录 / 网络，跳过才不像坏了 */
function classifyWhy(raw) {
  const t = String(raw || '');
  if (/vip|会员|付费/i.test(t)) return 'VIP 限制';
  if (/版权|下架|无版权|地区|不可播/i.test(t)) return '版权下架';
  if (/登录|cookie|凭据|unauthorized|401/i.test(t)) return '音源未登录';
  if (/超时|timeout|网络|加载失败|502|503|504|代理/i.test(t)) return '音源加载失败';
  return t ? t.replace(/[（(].*?[）)]/g, '').slice(0, 12) : '不可播';
}

function skipUnplayable(s, from, why) {
  if (!s) return setPlayingUI(false);
  deadSet.add(deadKey(s));
  s.ewWhy = classifyWhy(why);
  state.failStreak = (state.failStreak || 0) + 1;
  renderQueue();

  const n = state.queue.length;
  const limit = Math.min(n, SKIP_LIMIT);
  if (state.failStreak >= Math.max(1, limit)) {
    state.failStreak = 0;
    setPlayingUI(false);
    $('mini').hidden = false;
    $('mini-artist').textContent = n <= 1 ? '⚠ 这首歌取不到播放地址' : `⚠ 连续 ${limit} 首都取不到播放地址`;
    toast(
      n <= 1
        ? '这首歌取不到播放地址，多半是 VIP 或版权限制。点右上角头像看看是不是没登录。'
        : `连续 ${limit} 首都取不到播放地址，先停在这里。多半是该音源没登录，或地址全都失效了。`,
      true
    );
    return;
  }
  // 连着跳时只报一句「连跳 N 首」，别让前一条提示被下一条顶掉
  if (state.failStreak > 1) toast(`连跳 ${state.failStreak} 首不可播 · 最近「${s.name}」`);
  else toast(`跳过「${s.name}」· ${s.ewWhy}`);
  playIndex(nextAfterFail(from));
}

/* ---------- 歌曲条目 ---------- */
function songEl(s, i, idxLabel) {
  const el = document.createElement('div');
  el.className = 'song';
  el.dataset.i = i;
  const SRC_LABEL = { netease: '云村', qq: 'QQ', qishui: '汽水', xy: '小宇宙' };
  const showTag = state.provider === 'all' || (s.provider && s.provider !== 'netease');
  const tag = showTag && s.provider
    ? `<span class="src-tag">${SRC_LABEL[s.provider] || s.provider}${s.isPodcast ? ' · 播客' : ''}</span>` : '';
  const alt = (s.alsoOn || []).length
    ? `<span class="src-tag alt">另见 ${s.alsoOn.map(p => SRC_LABEL[p] || p).join(' / ')}</span>` : '';
  // v2：回放队列里每条都带来源角标，「这段时间从哪来」一眼可追溯
  const from = s.ewSource ? `<span class="src-tag from">${escapeHtml(s.ewSource)}${s.plays > 1 ? ' ×' + s.plays : ''}</span>` : '';
  el.innerHTML = `
    <div class="song-idx">${idxLabel != null ? idxLabel : ''}</div>
    <img src="${coverUrl(s.cover) || 'icon.svg'}" loading="lazy" alt="">
    <div class="meta">
      <div class="name">${escapeHtml(s.name)}</div>
      <div class="artist">${escapeHtml(s.artist)}${s.fee === 1 ? ' · VIP' : ''}${tag}${alt}${from}</div>
    </div>`;
  // 播不出来的歌留在列表里，但说清原因——「灰掉」会让人以为应用坏了
  if (isDead(s)) {
    el.classList.add('is-dead');
    el.querySelector('.artist').insertAdjacentHTML('beforeend',
      `<span class="dead-tag">${escapeHtml(s.ewWhy || '不可播')}</span>`);
  }
  el.addEventListener('click', () => {
    // 手动点等于「再试一次」：清掉跳过记录，允许重新换源
    deadSet.delete(deadKey(s));
    delete s._fallbackTried;
    delete s._retried;
    if (s.provider === 'xy' && s.isPodcast) openXYPodcast(s.pid || s.id);
    else playIndex(i);
  });
  return el;
}
function markPlaying() {
  document.querySelectorAll('.song').forEach(el =>
    el.classList.toggle('playing', Number(el.dataset.i) === state.index && el.closest('.results,.queue-list')));
  renderQueue();
}

/* ---------- 播放 ---------- */
function renderQueue() {
  const box = $('queue-list'); box.innerHTML = '';
  state.queue.forEach((s, i) => {
    const el = songEl(s, i, i + 1);
    if (i === state.index) el.classList.add('playing');
    box.appendChild(el);
  });
  renderNextUp();
  saveState();
}
async function playIndex(i) {
  if (i < 0 || i >= state.queue.length) return;
  state.index = i;
  const s = state.queue[i];
  markPlaying();
  $('mini').hidden = false;
  $('mini-name').textContent = s.name;
  $('mini-artist').textContent = s.artist;
  $('stage-name').textContent = s.name;
  $('stage-artist').textContent = s.artist;
  const cv = coverUrl(s.cover);
  $('mini-cover').src = cv || 'icon.svg';
  $('stage-cover').src = cv || 'icon.svg';
  $('stage-bg').style.backgroundImage = cv ? `url(${cv})` : 'none';
  paintFromCover(cv || '');
  $('fee-badge').hidden = s.fee !== 1;
  $('quality-badge').hidden = true;
  loadLyrics(s);
  refreshLikeState(s);
  $('play-icon').textContent = '…'; $('mini-icon').textContent = '…';
  try {
    let url = '';
    if (s.provider === 'qq') {
      const info = await api(`/api/qq/song/url?mid=${encodeURIComponent(s.mid || s.id)}&mediaMid=${encodeURIComponent(s.mediaMid || '')}&quality=${state.quality === 'lossless' ? 'lossless' : 'standard'}`);
      if (!info.url) throw new Error(info.error || info.message || '取不到 QQ 播放地址（VIP 歌曲需登录）');
      // QQ 源多为 http，https 页面下需走代理
      url = apiUrl(`/api/audio?url=${encodeURIComponent(info.url)}`);
      if (info.level) { $('quality-badge').hidden = false; $('quality-badge').textContent = info.level; }
    } else if (s.provider === 'qishui') {
      const info = await api(`/api/qishui/song/url?id=${encodeURIComponent(s.id)}&quality=${state.quality}`);
      if (!info.url) throw new Error(info.message || info.error || '取不到汽水播放地址（需登录汽水）');
      url = apiUrl(`/api/audio?url=${encodeURIComponent(info.url)}`);
      if (info.level || info.qualityLabel) { $('quality-badge').hidden = false; $('quality-badge').textContent = info.level || info.qualityLabel; }
    } else if (s.provider === 'xy') {
      const e = await api(`/api/xy/episode?id=${encodeURIComponent(s.epid || s.id)}`);
      const ep = e.episode || {};
      if (!e.enclosure || !e.enclosure.url) throw new Error('取不到单集音频');
      url = apiUrl(`/api/audio?url=${encodeURIComponent(e.enclosure.url)}`);
      s._shownotes = ep.shownotes || '';
    } else {
      const info = await api(`/api/song/url?id=${s.id}&quality=${state.quality}`);
      url = info.url || (info.playback && info.playback.url);
      if (!url) throw new Error(info.error || info.message || '取不到播放地址（VIP 或版权歌曲需登录）');
      // 统一走代理（同源），保证 Web Audio 频谱可用
      url = apiUrl(`/api/audio?url=${encodeURIComponent(url)}`);
      if (info.level) {
        $('quality-badge').hidden = false;
        $('quality-badge').textContent = info.level;
      }
    }
    const seek = state.pendingSeek; state.pendingSeek = 0;
    audio.src = url;
    state._curSrc = audio.src;
    ensureAudioGraph();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    if (seek) audio.addEventListener('loadedmetadata', function once() {
      audio.currentTime = seek; audio.removeEventListener('loadedmetadata', once);
    }, { once: true });
    // play() 的拒绝交给 error 事件统一处理，别让它变成 unhandled rejection
    audio.play().catch(() => { });
    bumpStats(s);
    saveState();
  } catch (err) {
    // 统一音源：当前平台取不到地址（VIP / 版权 / 未登录）时自动换到其它平台的可播版本
    if (!s._fallbackTried) {
      s._fallbackTried = true;
      try {
        const alt = await api(`/api/unified/alternatives?name=${encodeURIComponent(s.name)}&artist=${encodeURIComponent(s.artist || '')}&exclude=${encodeURIComponent(s.provider || 'netease')}`);
        const pick = (alt.candidates || [])[0];
        if (pick) {
          state.queue[i] = Object.assign({}, pick, { _fallbackTried: true });
          $('mini-artist').textContent = `已自动换到「${PROVIDER_LABEL[pick.provider] || pick.provider}」音源…`;
          renderQueue();
          return playIndex(i);
        }
      } catch { /* 换源失败则往下跳，不停在这一首 */ }
    }
    // 换源也不成：直接放下一首（用户要求：取不到地址就往后放）
    // 保留完整错误信息，classifyWhy 才能从「VIP / 版权 / 需登录」里分出原因
    skipUnplayable(s, i, String((err && err.message) || '取不到播放地址'));
  }
}
function setPlayingUI(p) {
  state.playing = p;
  $('play-icon').textContent = p ? '❚❚' : '▶';
  $('mini-icon').textContent = p ? '❚❚' : '▶';
  $('stage').classList.toggle('paused', !p);
  $('mini').classList.toggle('paused', !p);
}
function toggle() { if (!audio.src) return; audio.paused ? audio.play().catch(() => { }) : audio.pause(); }
audio.addEventListener('play', () => { state.failStreak = 0; state._playStartedAt = Date.now(); setPlayingUI(true); saveState(); });
audio.addEventListener('pause', () => { setPlayingUI(false); saveState(); });
/* 地址拿到了、实际却拉不下来（404 / 代理 502 / 版权抽检）：
   跟取不到地址一样往后跳，别让界面显示「播放中」却一点声音都没有。
   但要区分两种情况：已经正常播了一会儿再断，是网络抖动，先原地重试一次；
   一开播就失败，才是真的取不到。 */
audio.addEventListener('error', () => {
  if (!audio.src) return;
  if (audio.error && audio.error.code === 1) return;            // ABORTED：切歌/换源时的正常中断
  if (!audio.error) return;
  if (state._curSrc && audio.src !== state._curSrc) return;      // 迟到的旧地址报错，别误跳新歌
  const s = state.queue[state.index];
  if (!s) return;
  const playedLong = state._playStartedAt && Date.now() - state._playStartedAt > 4000;
  if (playedLong && !s._retried) {
    // 播了一阵才断：多数是地址过期或网络抖了一下。重取一次地址，别急着判死
    s._retried = true;
    toast(`「${s.name}」中断，正在重连…`);
    return playIndex(state.index);
  }
  skipUnplayable(s, state.index, '音源加载失败');
});
audio.addEventListener('ended', () => {
  if (state.mode === 'one') { audio.currentTime = 0; audio.play().catch(() => { }); return; }
  if (state.mode === 'shuffle' && state.queue.length) return playIndex(Math.floor(Math.random() * state.queue.length));
  playIndex(state.index + 1);
});
audio.addEventListener('timeupdate', () => {
  const d = audio.duration || 0, c = audio.currentTime || 0;
  $('t-cur').textContent = fmt(c); $('t-dur').textContent = fmt(d);
  $('seek').value = d ? Math.round(c / d * 1000) : 0;
  $('mini-progress').firstElementChild.style.width = d ? (c / d * 100) + '%' : '0';
  $('bar-time').textContent = fmt(c) + ' / ' + fmt(d);
  syncLyric(c);
  tickStats();
  if (Math.floor(c) % 5 === 0) saveState();
});
$('seek').addEventListener('input', (e) => { if (audio.duration) audio.currentTime = e.target.value / 1000 * audio.duration; });
$('toggle').addEventListener('click', toggle);
$('mini-toggle').addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
$('prev').addEventListener('click', () => playIndex(state.index - 1));
$('next').addEventListener('click', () => playIndex(state.index + 1));

/* ---------- 持久化 ---------- */
function saveState() {
  try {
    localStorage.setItem('ew_state', JSON.stringify({
      queue: state.queue.slice(0, 200), index: state.index,
      time: audio.currentTime || 0, playing: state.playing,
    }));
  } catch { /* 满 */ }
}
function restoreState() {
  try {
    const s = JSON.parse(localStorage.getItem('ew_state') || 'null');
    if (!s || !s.queue || !s.queue.length) return;
    state.queue = s.queue; state.index = s.index ?? 0;
    state.pendingSeek = s.time || 0;
    renderQueue();
    const cur = state.queue[state.index];
    if (cur) {
      $('mini').hidden = false;
      $('mini-name').textContent = cur.name;
      $('mini-artist').textContent = cur.artist + ' · 继续听';
      const cv = coverUrl(cur.cover);
      $('mini-cover').src = cv || 'icon.svg';
      $('stage-cover').src = cv || 'icon.svg';
      $('stage-bg').style.backgroundImage = cv ? `url(${cv})` : 'none';
      $('stage-name').textContent = cur.name;
      $('stage-artist').textContent = cur.artist;
      paintFromCover(cv || '');
      $('mini-toggle').addEventListener('click', () => playIndex(state.index), { once: true });
      $('recent-sub').textContent = cur.name;
      updateContinueCard();
    }
  } catch { /* ignore */ }
}

/* ---------- 播放模式 ---------- */
function applyMode() {
  const ico = state.mode === 'one' ? '⟳' : state.mode === 'shuffle' ? '⤨' : '⇉';
  $('mode-icon').textContent = ico;
  const sm = $('stage-mode-icon'); if (sm) sm.textContent = ico;
  localStorage.setItem('ew_mode', state.mode);
}
$('mode-btn').addEventListener('click', () => {
  state.mode = state.mode === 'order' ? 'one' : state.mode === 'one' ? 'shuffle' : 'order';
  applyMode();
});
applyMode();

/* ---------- 音质选择 ---------- */
function renderQualityMenu() {
  const wrap = $('q-list');
  wrap.innerHTML = '';
  QUALITIES.forEach(q => {
    const b = document.createElement('button');
    b.className = 'q-item' + (q.key === state.quality ? ' cur' : '');
    b.textContent = q.label;
    b.onclick = () => {
      state.quality = q.key;
      localStorage.setItem('ew_quality', q.key);
      renderQualityMenu();
      $('quality-menu').hidden = true;
      if (state.index >= 0) playIndex(state.index);
    };
    wrap.appendChild(b);
  });
}
$('quality-btn').addEventListener('click', () => {
  renderQualityMenu();
  const m = $('quality-menu');
  m.hidden = !m.hidden;
});
$('quality-close').addEventListener('click', () => { $('quality-menu').hidden = true; });

/* ---------- 红心（仅网易云） ---------- */
async function refreshLikeState(song) {
  const s = typeof song === 'object' ? song : { id: song };
  if (!state.user || !s.id || (s.provider && s.provider !== 'netease')) return;
  try {
    const r = await api(`/api/song/like/check?ids=${id}`);
    const ids = r.likedIds || [];
    state.liked[id] = Array.isArray(ids) ? ids.includes(String(id)) : !!((r.liked || {})[id]);
    updateHeartUI();
  } catch { /* ignore */ }
}
function updateHeartUI() {
  const cur = state.queue[state.index];
  const on = cur && (state.liked[cur.id] || isCollected(cur.id));
  $('mini-like').textContent = on ? '♥' : '♡';
  $('mini-like').classList.toggle('on', !!on);
  $('like-btn').textContent = on ? '♥' : '♡';
  $('like-btn').classList.toggle('on', !!on);
}
async function toggleLike() {
  const cur = state.queue[state.index];
  if (!cur) return;
  // 网易云登录态：红心云端；否则存入本地收藏夹
  if (cur.provider === 'netease' && state.user) {
    const next = !state.liked[cur.id];
    try {
      await api('/api/song/like', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: cur.id, like: next }) });
      state.liked[cur.id] = next;
    } catch { /* ignore */ }
  } else {
    toggleCollect(cur);
  }
  updateHeartUI();
}
$('like-btn').addEventListener('click', toggleLike);
$('mini-like').addEventListener('click', (e) => { e.stopPropagation(); toggleLike(); });

/* ---------- 播放页开关 ---------- */
function openStage() {
  $('stage').hidden = false;
  requestAnimationFrame(() => { $('stage').classList.add('show'); ensureInkSize(); });
}
function closeStage() { $('stage').classList.remove('show'); setTimeout(() => { $('stage').hidden = true; }, 420); }
$('mini-expand').addEventListener('click', (e) => { e.stopPropagation(); openStage(); });
$('bar-lyric').addEventListener('click', (e) => { e.stopPropagation(); openStage(); });
$('mini-cover').addEventListener('click', (e) => { e.stopPropagation(); openStage(); });
$('mini-meta').addEventListener('click', (e) => { e.stopPropagation(); openStage(); });
$('prev').addEventListener('click', (e) => e.stopPropagation());
$('next').addEventListener('click', (e) => e.stopPropagation());
$('mini-toggle').addEventListener('click', (e) => e.stopPropagation());
$('bar-vol').addEventListener('click', (e) => e.stopPropagation());
$('stage-close').addEventListener('click', closeStage);
/* 舞台内的复用控件（与播放条同源状态） */
$('stage-prev').addEventListener('click', () => playIndex(state.index - 1));
$('stage-next').addEventListener('click', () => playIndex(state.index + 1));
$('stage-mode').addEventListener('click', () => $('mode-btn').click());
$('stage-queue').addEventListener('click', openQueue);

/* ---------- 队列抽屉 ---------- */
function openQueue() {
  renderQueue();
  $('queue-drawer').hidden = false; $('queue-mask').hidden = false;
  requestAnimationFrame(() => $('queue-drawer').classList.add('show'));
}
function closeQueue() {
  $('queue-drawer').classList.remove('show');
  setTimeout(() => { $('queue-drawer').hidden = true; $('queue-mask').hidden = true; }, 340);
}
$('queue-btn').addEventListener('click', openQueue);
$('queue-close').addEventListener('click', closeQueue);
$('queue-mask').addEventListener('click', closeQueue);

/* ---------- 歌词 ---------- */
function parseLrc(text) {
  const out = [];
  const raw = String(text || '').trim();
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      const arr = JSON.parse(raw);
      const list = Array.isArray(arr) ? arr : (arr.lines || [arr]);
      list.forEach(item => {
        const tx = (item.c || []).map(c => c.tx || '').join('').trim();
        const t = Number(item.t || 0);
        if (tx) out.push({ t: t > 100000 ? t / 1000 : t, text: tx });
      });
      return out.sort((a, b) => a.t - b.t);
    } catch { /* fallthrough */ }
  }
  raw.split('\n').forEach(line => {
    const m = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    const txt = line.replace(/\[[^\]]*\]/g, '').trim();
    if (m.length && txt) m.forEach(t => out.push({ t: (+t[1]) * 60 + (+t[2]), text: txt }));
  });
  return out.sort((a, b) => a.t - b.t);
}
/* 逐字格式: [行起,行长](字起,字长,0)字 … */
function parseYrc(text) {
  const out = [];
  String(text || '').split('\n').forEach(line => {
    const head = line.match(/^\[(\d+),(\d+)\]/);
    if (!head) return;
    const words = [];
    for (const w of line.matchAll(/\((\d+),(\d+),\d+\)([^(]*)/g)) {
      const tx = w[3];
      if (tx.trim()) words.push({ start: (+w[1]) / 1000, dur: (+w[2]) / 1000, text: tx });
    }
    if (words.length) out.push({ t: (+head[1]) / 1000, dur: (+head[2]) / 1000, words });
  });
  return out.sort((a, b) => a.t - b.t);
}
async function loadLyrics(song) {
  const s = typeof song === 'object' ? song : { id: song };
  $('lyrics').innerHTML = '';
  state.lyrics = []; state.curLyric = -1; state.karaoke = false;
  try {
    let d;
    if (s.provider === 'qq') d = await api(`/api/qq/lyric?mid=${encodeURIComponent(s.mid || s.id)}&id=${s.songId || ''}`);
    else if (s.provider === 'qishui') d = await api(`/api/qishui/lyric?id=${encodeURIComponent(s.id)}`);
    else if (s.provider === 'xy') {
      // 播客无歌词，展示 shownotes 文本
      let notes = s._shownotes || '';
      if (!notes) {
        try { const e = await api(`/api/xy/episode?id=${encodeURIComponent(s.epid || s.id)}`); notes = (e.episode && e.episode.shownotes) || ''; } catch { /* ignore */ }
      }
      const text = notes.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
      const lines = text.split('\n').map(x => x.trim()).filter(Boolean).slice(0, 80);
      lines.forEach((t, i) => {
        const el = document.createElement('div');
        el.className = 'line'; el.dataset.i = i;
        el.textContent = t;
        $('lyrics').appendChild(el);
      });
      if (!lines.length) { const el = document.createElement('div'); el.className = 'line'; el.textContent = '（本单集无 shownotes）'; $('lyrics').appendChild(el); }
      return;
    }
    else d = await api(`/api/lyric?id=${s.id}`);
    const yrc = parseYrc(d.yrc);
    if (yrc.length) {
      state.lyrics = yrc; state.karaoke = true;
      yrc.forEach((l, i) => {
        const el = document.createElement('div');
        el.className = 'line karaoke'; el.dataset.i = i;
        l.words.forEach(w => {
          const sp = document.createElement('span');
          sp.textContent = w.text;
          sp.dataset.start = w.start; sp.dataset.end = w.start + w.dur;
          el.appendChild(sp);
        });
        el.addEventListener('click', () => { if (audio.duration) audio.currentTime = l.t; });
        $('lyrics').appendChild(el);
      });
      return;
    }
    state.lyrics = parseLrc(d.lyric || d.lrc || '');
    const trans = parseLrc(d.tlyric || d.translation || '');
    if (trans.length) state.lyrics = state.lyrics.map(l => {
      const tr = trans.find(t => Math.abs(t.t - l.t) < 0.5);
      return tr ? { t: l.t, text: l.text + '\n' + tr.text } : l;
    });
    state.lyrics.forEach((l, i) => {
      const el = document.createElement('div');
      el.className = 'line'; el.dataset.i = i;
      el.innerHTML = escapeHtml(l.text).replace('\n', '<br>');
      el.addEventListener('click', () => { if (audio.duration) audio.currentTime = l.t; });
      $('lyrics').appendChild(el);
    });
  } catch { /* 无歌词静默 */ }
}
function syncLyric(c) {
  if (!state.lyrics.length) return;
  let idx = -1;
  for (let i = 0; i < state.lyrics.length; i++) { if (state.lyrics[i].t <= c + .2) idx = i; else break; }
  if (idx === state.curLyric) { if (state.karaoke && idx >= 0) paintKaraoke(idx, c); return; }
  state.curLyric = idx;
  const nodes = $('lyrics').children;
  for (const n of nodes) n.classList.toggle('cur', Number(n.dataset.i) === idx);
  const cur = nodes[idx];
  if (cur) $('lyrics').scrollTop = cur.offsetTop - $('lyrics').clientHeight / 2 + cur.offsetHeight;
  if (state.karaoke && idx >= 0) paintKaraoke(idx, c);
}
function paintKaraoke(idx, c) {
  const el = $('lyrics').children[idx];
  if (!el) return;
  for (const sp of el.children) {
    const s = +sp.dataset.start, e = +sp.dataset.end;
    sp.classList.toggle('lit', c >= e);
    sp.classList.toggle('singing', c >= s && c < e);
  }
}

/* ---------- 已登录：账号信息卡片（不再显示扫码区） ---------- */
const ACCT_IDS = ['netease', 'qishui', 'qq', 'xy'];
const ACCT_LOGOUT_API = {
  netease: '/api/logout', qishui: '/api/qishui/logout',
  qq: '/api/qq/logout', xy: '/api/xy/logout',
};
function avatarUrl(p) {
  const a = p && p.avatar;
  if (!a) return '';
  if (typeof a === 'string') return a;
  return a.smallPicUrl || a.thumbnailUrl || a.picUrl || a.middlePicUrl || '';
}
function renderAcctPanel(p) {
  const box = $('lp-' + p.id + '-account');
  if (!box) return;
  const name = String(p.nickname || p.userId || p.label || '已登录');
  const uid = String(p.userId || '—');
  const detail = String(p.detail || (p.id === 'qishui' ? '扫码登录' : '已连接'));
  const via = (p.loginMethods || []).join(' / ') || p.hint || '扫码授权';
  const caps = (p.capabilities || []).slice(0, 8);
  const av = avatarUrl(p);
  box.innerHTML = `
    <div class="acct-head">
      <div class="acct-avatar">${av
        ? `<img src="${escapeHtml(av)}" alt="">`
        : `<span class="acct-glyph">${escapeHtml(p.glyph || '源')}</span>`}</div>
      <div class="acct-who"><b>${escapeHtml(name)}</b><small>${escapeHtml(p.label || PROVIDER_LABEL[p.id] || p.id)}</small></div>
      <span class="acct-state">已连接</span>
    </div>
    <div class="acct-meta">
      <div class="acct-row"><span>账号 ID</span><b>${escapeHtml(uid)}</b></div>
      <div class="acct-row"><span>账号状态</span><b>${escapeHtml(detail)}</b></div>
      <div class="acct-row"><span>登录方式</span><b>${escapeHtml(String(via))}</b></div>
    </div>
    <div class="acct-caps">${caps.length
      ? caps.map(c => `<i>${escapeHtml(String(c))}</i>`).join('')
      : '<i>曲库与播放已解锁</i>'}</div>
    <div class="acct-actions">
      <button class="acct-btn" data-act="refresh">刷新状态</button>
      <button class="acct-btn ghost" data-act="egg-first">彩蛋 · 初次相遇</button>
      <button class="acct-btn ghost" data-act="egg-return">彩蛋 · 久别重逢</button>
      <button class="acct-btn danger" data-act="logout">退出登录</button>
    </div>
    <p class="acct-tip">凭据只存在本机；退出后需重新授权，重新登录会有一枚新彩蛋。</p>`;
  box.querySelectorAll('[data-act]').forEach(btn => {
    btn.onclick = async () => {
      const act = btn.dataset.act;
      if (act === 'refresh') { await refreshAccountStatus(true); applyLoginPanels(); return; }
      if (act === 'egg-first' || act === 'egg-return') {
        if (window.Egg) Egg.replay(act === 'egg-first' ? 'first' : 'return');
        return;
      }
      if (act === 'logout') await logoutProvider(p.id);
    };
  });
}
function applyLoginPanels() {
  const list = state.accountStatus && Array.isArray(state.accountStatus.providers)
    ? state.accountStatus.providers : [];
  ACCT_IDS.forEach(id => {
    const form = $('lp-' + id + '-form'), panel = $('lp-' + id + '-account');
    if (!form || !panel) return;
    const p = list.find(x => x.id === id);
    const on = !!(p && p.loggedIn);
    form.hidden = on;
    panel.hidden = !on;
    if (on) {
      renderAcctPanel(p);
      // 已经登录就别再让二维码在后台空转
      if (id === 'qishui') {
        cancelQishuiQr();
        const im = $('qishui-qr-img'); if (im) im.hidden = true;
      }
      if (id === 'qq') {
        cancelQQQr();
        const im = $('qq-qr-img'); if (im) im.hidden = true;
      }
      if (id === 'netease') { clearInterval(state.qrTimer); state.qrTimer = null; }
    }
  });
}
async function logoutProvider(id) {
  if (!confirm(`退出「${PROVIDER_LABEL[id] || id}」并清除本机凭据？`)) return;
  try { await api(ACCT_LOGOUT_API[id]); } catch { /* 忽略 */ }
  try { await postEggEvent('logout', id); } catch { /* 忽略 */ }
  // 先落位图，避免状态刷新时把同一次退出重复上报
  if (eggLoginMap) {
    eggLoginMap[id] = false;
    try { localStorage.setItem('ew_login_map', JSON.stringify(eggLoginMap)); } catch { }
  }
  await refreshAccountStatus(true);
  applyLoginPanels();
  refreshLoginStatus();
}
function postEggEvent(type, provider) {
  return api('/api/login/egg/event', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, provider }),
  });
}
/* 只在「未登录 → 已登录」或反向变化时上报，应用启动不误弹彩蛋 */
async function syncLoginEggEvents(d) {
  if (!d || d.degraded || !Array.isArray(d.providers)) return;
  const map = {};
  ACCT_IDS.forEach(id => { map[id] = !!((d.providers.find(p => p.id === id) || {}).loggedIn); });
  const prev = eggLoginMap;
  eggLoginMap = map;
  try { localStorage.setItem('ew_login_map', JSON.stringify(map)); } catch { }
  if (!prev) return; // 第一次只建立基线
  const wentOn = ACCT_IDS.filter(id => map[id] && !prev[id]);
  const wentOff = ACCT_IDS.filter(id => !map[id] && prev[id]);
  if (wentOn.length) await postEggEvent('login', wentOn[0]);
  else if (wentOff.length) await postEggEvent('logout', wentOff[0]);
  if (window.Egg) Egg.poll();
}

/* ---------- 登录弹窗（多平台） ---------- */
const LOGIN_TABS = ['all', 'netease', 'qishui', 'qq', 'xy'];
function providerLoggedIn(id) {
  const d = state.accountStatus;
  if (!d || d.degraded || !Array.isArray(d.providers)) return false;
  return !!((d.providers.find(p => p.id === id) || {}).loggedIn);
}
function switchLoginTab(lp) {
  const tab = LOGIN_TABS.includes(lp) ? lp : 'all';
  $('login-tabs').querySelectorAll('.login-tab').forEach(b => b.classList.toggle('cur', b.dataset.lp === tab));
  LOGIN_TABS.forEach(p => { $('lp-' + p).hidden = p !== tab; });
  applyLoginPanels();
  if (tab === 'all') refreshAccountStatus();
  // 已登录的账号不再生成二维码，只显示账号卡片
  if (tab === 'netease' && !providerLoggedIn('netease')) startQrLogin();
  else { clearInterval(state.qrTimer); state.qrTimer = null; }
  if (tab === 'qishui') {
    checkQishuiStatus();
    if (!providerLoggedIn('qishui') && !qishuiQrTimer && !qishuiQrToken) startQishuiQr();
    else cancelQishuiQr();
  } else cancelQishuiQr();
  if (tab === 'qq') {
    checkQQStatus(); refreshQQVipStatus();
    if (!providerLoggedIn('qq') && !qqQrTimer && !qqQrId) startQQQr();
    else cancelQQQr();
  } else cancelQQQr();
  if (tab === 'xy') checkXYStatus();
}
async function startQrLogin() {
  $('qr-status').textContent = '正在生成二维码…';
  try {
    const k = await api('/api/login/qr/key');
    if (!k.key) throw new Error(k.error || 'key 获取失败');
    state.qrKey = k.key;
    const c = await api(`/api/login/qr/create?key=${k.key}`);
    $('qr-img').src = c.img || c.qrimg || '';
    pollQr();
  } catch (err) { $('qr-status').textContent = '⚠ ' + err.message + '（点「刷新二维码」重试）'; }
}
function openLogin(lp) {
  $('login-modal').hidden = false;
  switchLoginTab(typeof lp === 'string' ? lp : 'all');
  // 打开后再校准一次，避免缓存里的登录位图让已登录账号闪一下二维码
  refreshAccountStatus(true).then(applyLoginPanels);
}
let qishuiQrToken = '', qishuiQrTimer = null, qishuiQrGen = 0, qishuiQrBusy = false;
function stopQishuiQrPoll() {
  if (qishuiQrTimer) { clearInterval(qishuiQrTimer); qishuiQrTimer = null; }
}
/* 切走标签页 / 关闭弹窗时，连同「还在生成中」的二维码一起作废 */
function cancelQishuiQr() { qishuiQrGen++; stopQishuiQrPoll(); qishuiQrToken = ''; }
async function checkQishuiStatus() {
  const st = $('qishui-cookie-status');
  st.textContent = '查询登录态……';
  try {
    const r = await api('/api/qishui/status');
    st.textContent = r.loggedIn
      ? `✓ 已登录：${r.nickname || r.userId}（${r.vipLabel || r.vipLevel || ''}）`
      : (r.qrAvailable ? '未登录，用抖音 App 扫上面的二维码' : '未登录；当前机器没有 Chrome / Electron，请用下方手动粘贴 cookie');
  } catch (e) { st.textContent = '⚠ ' + e.message; }
}

/* 抖音 App 扫码：二维码由服务端签名引擎生成，前端只负责展示与轮询 */
async function startQishuiQr() {
  const gen = ++qishuiQrGen;
  stopQishuiQrPoll();
  const qrSt = $('qishui-qr-status'), img = $('qishui-qr-img'), btn = $('qishui-qr-refresh');
  btn.disabled = true; img.hidden = true;
  qrSt.textContent = '正在生成二维码（首次要启动本机浏览器内核，约 5–15 秒）……';
  try {
    const r = await api('/api/qishui/login/qrcode', { method: 'POST' });
    if (gen !== qishuiQrGen) return; // 已切走或刷新，丢弃这次结果
    if (!r.ok || !r.qrcode) { qrSt.textContent = '⚠ ' + (r.error || '二维码生成失败'); btn.disabled = false; return; }
    qishuiQrToken = r.token;
    img.src = r.qrcode; img.hidden = false; btn.disabled = false;
    qrSt.textContent = '请用抖音 App 扫码，并在手机上确认';
    qishuiQrTimer = setInterval(async () => {
      if (!qishuiQrToken || $('login-modal').hidden || qishuiQrBusy) {
        if (!qishuiQrToken) stopQishuiQrPoll();
        return;
      }
      qishuiQrBusy = true;
      try {
        const c = await api('/api/qishui/login/check?token=' + encodeURIComponent(qishuiQrToken));
        if (!c.ok) {
          // 二次验证取消、签名失败等：必须让用户看见原因，不能一直停在等待扫码
          stopQishuiQrPoll(); qishuiQrToken = '';
          qrSt.textContent = '⚠ ' + (c.error || '验证失败') + '，点「生成 / 刷新二维码」重试';
          return;
        }
        const s = String(c.status || '');
        if (c.confirmed) {
          stopQishuiQrPoll(); qishuiQrToken = '';
          if (c.cookieReady) {
            qrSt.textContent = '✓ 登录成功，凭据已存到本机';
          } else {
            // 「手机确认」和「拿到票据」是两件事，把具体原因摆出来，别再让用户盲扫
            qrSt.textContent = '⚠ 手机已确认，但本机没拿到凭据：' + (c.reason || '未取得登录票据') +
              '。可展开下方「手动粘贴 cookie」填入，或点刷新重扫一次。';
            const input = $('qishui-cookie-input');
            const fold = input && input.closest('details');
            if (fold) fold.open = true;
            if (c.cookieDebug) console.warn('[汽水登录] 凭据诊断（只有字段名，无票据值）', c.cookieDebug);
          }
          checkQishuiStatus(); refreshLoginStatus();
        } else if (s === '3' || s === 'confirmed') qrSt.textContent = '已确认，正在写入凭据……';
        else if (s === '2' || s === 'scanned') qrSt.textContent = '已扫码，请在手机上点确认';
        else if (Number(c.error_code) === 2 || s === 'expired') {
          stopQishuiQrPoll(); qishuiQrToken = '';
          qrSt.textContent = '二维码已过期，点「生成 / 刷新二维码」重试';
        } else qrSt.textContent = '等待扫码…';
      } catch { /* 网络抖动忽略 */ }
      finally { qishuiQrBusy = false; }
    }, 2500);
  } catch (e) { qrSt.textContent = '⚠ ' + e.message; btn.disabled = false; }
}
$('qishui-qr-refresh').addEventListener('click', startQishuiQr);
$('qishui-qr-clear').addEventListener('click', () => {
  cancelQishuiQr();
  api('/api/qishui/logout').then(() => {
    $('qishui-qr-img').hidden = true;
    $('qishui-qr-status').textContent = '点上面按钮生成二维码';
    $('qishui-cookie-status').textContent = '已退出';
    refreshLoginStatus();
  });
});
async function checkQQStatus() {
  const st = $('qq-cookie-status');
  st.textContent = '查询登录态……';
  try {
    const r = await api('/api/qq/status');
    const auth = r.authorization || {};
    st.textContent = r.loggedIn
      ? `✓ 已登录：${r.nickname || r.uin} · ${auth.label || '播放授权已保存'}`
      : '未登录，扫码后自动保存凭据（VIP 歌曲需登录）';
  } catch (e) { st.textContent = '⚠ ' + e.message; }
}

/* QQ 音乐：三条扫码通道（手机 QQ / 微信 / QQ 音乐 App），凭据由服务端换取并落盘 */
let qqQrChannel = 'qq', qqQrId = '', qqQrTimer = null, qqQrBusy = false, qqQrGen = 0;
function stopQQQrPoll() {
  if (qqQrTimer) { clearInterval(qqQrTimer); qqQrTimer = null; }
  qqQrBusy = false;
}
function cancelQQQr() { qqQrGen++; stopQQQrPoll(); qqQrId = ''; }
async function refreshQQVipStatus() {
  const box = $('qq-vip-status');
  box.classList.remove('ready');
  box.textContent = '正在检查 VIP 播放授权…';
  try {
    const r = await api('/api/qq/playback/auth');
    if (!r.loggedIn) {
      box.textContent = 'VIP 播放授权 · 未登录。扫码成功后会自动换取播放密钥，解锁 VIP / 无损曲目。';
      return;
    }
    const who = r.uin ? ` · uin ${r.uin}` : '';
    const vip = r.vipKnown ? ` · ${r.vipLabel}` : ' · 会员态待确认';
    box.classList.add('ready');
    box.innerHTML = `<b>VIP 播放授权已就绪</b>${who}${vip}<br>${escapeHtml(r.hint || '')}`;
  } catch (e) { box.textContent = '⚠ 授权状态查询失败：' + e.message; }
}
async function startQQQr() {
  const gen = ++qqQrGen;
  stopQQQrPoll();
  const st = $('qq-qr-status'), img = $('qq-qr-img'), btn = $('qq-qr-refresh');
  btn.disabled = true; img.hidden = true;
  st.textContent = '正在生成二维码…';
  try {
    const r = await api('/api/qq/qr/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: qqQrChannel }),
    });
    if (gen !== qqQrGen) return; // 已切走或换通道，丢弃这次结果
    if (!r.ok || !r.qrcode) { st.textContent = '⚠ ' + (r.error || '二维码生成失败'); btn.disabled = false; return; }
    qqQrId = r.id;
    img.src = r.qrcode; img.hidden = false; btn.disabled = false;
    st.textContent = r.hint || '请用对应 App 扫码并在手机上确认';
    qqQrTimer = setInterval(async () => {
      if (!qqQrId || $('login-modal').hidden || qqQrBusy) { if (!qqQrId) stopQQQrPoll(); return; }
      qqQrBusy = true;
      try {
        const c = await api(`/api/qq/qr/check?channel=${encodeURIComponent(qqQrChannel)}&id=${encodeURIComponent(qqQrId)}`);
        if (!c.ok) { st.textContent = '⚠ ' + (c.message || c.error || '状态查询失败'); return; }
        if (c.confirmed) {
          stopQQQrPoll(); qqQrId = '';
          st.textContent = '✓ 登录成功，凭据与播放授权已存到本机';
          img.hidden = true;
          checkQQStatus(); refreshQQVipStatus(); refreshLoginStatus();
          return;
        }
        st.textContent = c.message || '等待扫码…';
        if (c.status === 'expired' || c.status === 'canceled') { stopQQQrPoll(); qqQrId = ''; }
      } catch { /* 网络抖动忽略 */ }
      finally { qqQrBusy = false; }
    }, 2500);
  } catch (e) { st.textContent = '⚠ ' + e.message; btn.disabled = false; }
}
$('qq-channels').querySelectorAll('.qq-channel').forEach(b => b.addEventListener('click', () => {
  qqQrChannel = b.dataset.qqChannel || 'qq';
  $('qq-channels').querySelectorAll('.qq-channel').forEach(x => x.classList.toggle('cur', x === b));
  qqQrId = ''; startQQQr();
}));
$('qq-qr-refresh').addEventListener('click', () => { qqQrId = ''; startQQQr(); });
$('qq-qr-clear').addEventListener('click', () => {
  cancelQQQr();
  api('/api/qq/logout').then(() => {
    $('qq-qr-img').hidden = true;
    $('qq-qr-status').textContent = '点「生成 / 刷新二维码」重新扫码';
    $('qq-cookie-status').textContent = '已退出';
    $('qq-vip-status').classList.remove('ready');
    $('qq-vip-status').textContent = 'VIP 播放授权 · 未登录';
    refreshLoginStatus();
  });
});
$('login-tabs').querySelectorAll('.login-tab').forEach(b => b.addEventListener('click', () => switchLoginTab(b.dataset.lp)));
$('qishui-cookie-save').addEventListener('click', async () => {
  const st = $('qishui-cookie-status');
  const c = $('qishui-cookie-input').value.trim();
  if (!c) { st.textContent = '⚠ 请先粘贴 cookie'; return; }
  st.textContent = '保存中……';
  try {
    const r = await api('/api/qishui/login/cookie', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cookie: c }) });
    st.textContent = r.loggedIn ? '✓ 凭据已保存' : '⚠ cookie 无效或不含登录态';
    if (r.loggedIn) refreshLoginStatus();
  } catch (e) { st.textContent = '⚠ ' + e.message; }
});
$('qq-cookie-save').addEventListener('click', async () => {
  const st = $('qq-cookie-status');
  const c = $('qq-cookie-input').value.trim();
  if (!c) { st.textContent = '⚠ 请先粘贴 cookie'; return; }
  st.textContent = '保存中……';
  try {
    const r = await api('/api/qq/login/cookie', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cookie: c }) });
    st.textContent = r.loggedIn ? `✓ 登录成功：${r.nickname || r.uin}` : '⚠ cookie 无效或不含 uin/qm_keyst';
    if (r.loggedIn) { refreshQQVipStatus(); refreshLoginStatus(); }
  } catch (e) { st.textContent = '⚠ ' + e.message; }
});
const xyStatus = () => $('xy-token-status');
const xyCreds = () => ({ areaCode: $('xy-area').value, mobilePhoneNumber: $('xy-phone').value.trim() });
const xyPost = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function checkXYStatus() {
  const st = xyStatus();
  st.textContent = '查询登录态……';
  try {
    const r = await api('/api/xy/status');
    if (!r.loggedIn) { st.textContent = '未登录，填手机号收验证码后点「登录并保存」'; return; }
    const mins = r.at ? Math.floor((Date.now() - r.at) / 60000) : null;
    const age = mins === null ? '' : mins < 1 ? '（刚刚获取）' : mins < 60 ? `（${mins} 分钟前）` : `（约 ${Math.floor(mins / 60)} 小时前）`;
    const who = r.nickname || r.phone || '';
    const via = r.via === 'sms' ? '短信登录' : '手动凭据';
    st.textContent = '✓ 已登录' + (who ? '：' + who : '') + ' · ' + via + age;
  } catch (e) { st.textContent = '⚠ ' + e.message; }
}

$('xy-open-official').addEventListener('click', () => window.open('https://www.xiaoyuzhoufm.com/', '_blank', 'noopener,noreferrer'));

let xySendTimer = null;
$('xy-send').addEventListener('click', async () => {
  const btn = $('xy-send'), st = xyStatus();
  const creds = xyCreds();
  if (!creds.mobilePhoneNumber) { st.textContent = '⚠ 请先填手机号'; return; }
  btn.disabled = true; st.textContent = '正在请求发送验证码……';
  try {
    const r = await xyPost('/api/xy/login/send-code', creds);
    if (r.ok) {
      st.textContent = '✓ ' + (r.message || '验证码已发送') + '，收到后填到上面';
      $('xy-captcha-tip').hidden = true;
      let left = 60;
      btn.textContent = left + 's 后重发';
      clearInterval(xySendTimer);
      xySendTimer = setInterval(() => {
        if (--left <= 0) { clearInterval(xySendTimer); btn.textContent = '获取验证码'; btn.disabled = false; }
        else btn.textContent = left + 's 后重发';
      }, 1000);
    } else {
      btn.disabled = false; btn.textContent = '获取验证码';
      $('xy-captcha-tip').hidden = !(r.needCaptcha || r.captchaInvalid);
      st.textContent = '⚠ ' + (r.message || '发送失败');
    }
  } catch (e) {
    btn.disabled = false; btn.textContent = '获取验证码';
    st.textContent = '⚠ ' + e.message;
  }
});

$('xy-sms-login').addEventListener('click', async () => {
  const btn = $('xy-sms-login'), st = xyStatus();
  const body = Object.assign(xyCreds(), { verifyCode: $('xy-code').value.trim() });
  if (!body.mobilePhoneNumber || !body.verifyCode) { st.textContent = '⚠ 请填手机号和验证码'; return; }
  btn.disabled = true; st.textContent = '正在验证并保存凭据……';
  try {
    const r = await xyPost('/api/xy/login/sms', body);
    if (r.ok) {
      st.textContent = '✓ 登录成功，凭据已存到本机，可以搜索和听播客了';
      $('xy-code').value = '';
      $('xy-captcha-tip').hidden = true;
      refreshLoginStatus();
    } else {
      st.textContent = '⚠ ' + (r.message || '登录失败');
      if (r.needManualToken) document.querySelector('.xy-manual').open = true;
    }
  } catch (e) { st.textContent = '⚠ ' + e.message; }
  finally { btn.disabled = false; }
});

$('xy-token-save').addEventListener('click', async () => {
  const st = xyStatus();
  const t = $('xy-token-input').value.trim();
  if (!t) { st.textContent = '⚠ 请先粘贴 token'; return; }
  st.textContent = '验证中……';
  try {
    const r = await xyPost('/api/xy/login/token', { token: t });
    if (r.ok) { st.textContent = '✓ 凭据已保存，可以搜索和听播客了'; $('xy-token-input').value = ''; refreshLoginStatus(); }
    else st.textContent = '⚠ ' + (r.error || r.message || 'token 无效');
  } catch (e) { st.textContent = '⚠ ' + e.message; }
});
$('xy-token-clear').addEventListener('click', () => api('/api/xy/logout').then(() => { xyStatus().textContent = '已退出'; refreshLoginStatus(); }));
function pollQr() {
  clearInterval(state.qrTimer);
  state.qrTimer = setInterval(async () => {
    if (!state.qrKey) return clearInterval(state.qrTimer);
    try {
      const r = await api(`/api/login/qr/check?key=${state.qrKey}`);
      const code = r.code ?? r.statusCode;
      if (code === 800) { $('qr-status').textContent = '二维码已过期，请重开'; clearInterval(state.qrTimer); }
      else if (code === 802) $('qr-status').textContent = '已扫码，请在手机上确认';
      else if (code === 803) {
        $('qr-status').textContent = '✓ 登录成功';
        clearInterval(state.qrTimer); state.qrKey = null;
        setTimeout(() => { $('login-modal').hidden = true; refreshLoginStatus(); }, 800);
      }
      else $('qr-status').textContent = '等待扫码…';
    } catch { /* 网络抖动忽略 */ }
  }, 2500);
}
$('login-btn').addEventListener('click', () => openLogin('all'));
$('account-btn').addEventListener('click', () => openLogin('all'));
$('account-connect-next').addEventListener('click', connectNextSource);
$('account-refresh').addEventListener('click', () => refreshAccountStatus(true));
$('qr-refresh').addEventListener('click', startQrLogin);
$('unified-refresh').addEventListener('click', () => { refreshAccountStatus(true); loadUnifiedHome(); });
$('lib-refresh').addEventListener('click', () => loadUnifiedLibrary());
$('login-close').addEventListener('click', () => {
  $('login-modal').hidden = true;
  clearInterval(state.qrTimer); state.qrKey = null;
  cancelQishuiQr();
  cancelQQQr();
});

/* ---------- 倍速 ---------- */
const RATES = [1, 1.25, 1.5, 2, 0.75];
let rateIdx = 0;
$('rate-btn').addEventListener('click', () => {
  rateIdx = (rateIdx + 1) % RATES.length;
  audio.playbackRate = RATES[rateIdx];
  $('rate-icon').textContent = RATES[rateIdx] + '×';
});

/* ---------- 评论抽屉（复刻原版热评） ---------- */
function openComments() {
  $('comment-drawer').hidden = false;
  $('comment-mask').hidden = false;
  loadComments();
}
function closeComments() { $('comment-drawer').hidden = true; $('comment-mask').hidden = true; }
$('comment-btn').addEventListener('click', openComments);
$('comment-close').addEventListener('click', closeComments);
$('comment-mask').addEventListener('click', closeComments);
async function loadComments() {
  const box = $('comment-list');
  const cur = state.queue[state.index];
  box.innerHTML = '<div class="c-item"><div class="c-content">正在取评论……</div></div>';
  if (!cur) { box.innerHTML = '<div class="c-item"><div class="c-content">先放首歌再来</div></div>'; return; }
  if (cur.provider !== 'netease') { box.innerHTML = `<div class="c-item"><div class="c-content">「${cur.provider === 'xy' ? '小宇宙' : cur.provider === 'qq' ? 'QQ 音乐' : '汽水'}」暂不支持评论区</div></div>`; return; }
  try {
    const d = await api(`/api/comment?id=${cur.id}`);
    const item = (c) => `<div class="c-item"><img class="c-avatar" src="${coverUrl(c.user.avatar) || 'icon.svg'}" loading="lazy"><div class="c-body"><div class="c-head"><span class="c-nick">${escapeHtml(c.user.nickname)}</span><span class="c-likes">♥ ${c.likedCount}</span></div><div class="c-content">${escapeHtml(c.content)}</div></div></div>`;
    const hot = (d.hotComments || []).map(c => Object.assign({}, c, { likedCount: c.likedCount })).slice(0, 5);
    const rest = (d.comments || []);
    box.innerHTML = (hot.length ? '<div class="c-sec">云村热评</div>' + hot.map(item).join('') : '') +
      (rest.length ? '<div class="c-sec">最新评论</div>' + rest.map(item).join('') : '') ||
      '<div class="c-item"><div class="c-content">还没有人评论</div></div>';
  } catch (e) {
    box.innerHTML = `<div class="c-item"><div class="c-content">评论加载失败：${escapeHtml(e.message)}</div></div>`;
  }
}

/* ---------- 本地收藏夹（复刻原版 collect；未登录网易云时红心即收藏） ---------- */
function getCollects() { try { return JSON.parse(localStorage.getItem('ew_collect') || '[]'); } catch { return []; } }
function isCollected(id) { return getCollects().some(s => String(s.id) === String(id)); }
function toggleCollect(song) {
  let list = getCollects();
  const exists = list.some(s => String(s.id) === String(song.id));
  if (exists) list = list.filter(s => String(s.id) !== String(song.id));
  else {
    list.unshift({ provider: song.provider, id: song.id, mid: song.mid, mediaMid: song.mediaMid, epid: song.epid, pid: song.pid, isPodcast: song.isPodcast, name: song.name, artist: song.artist, cover: song.cover, fee: song.fee });
    if (list.length > 200) list.length = 200;
  }
  localStorage.setItem('ew_collect', JSON.stringify(list));
  renderCollects();
  return !exists;
}
function renderCollects() {
  const list = getCollects();
  const box = $('collect-list');
  if (!box) return;
  $('collect-section').hidden = !list.length;
  box.innerHTML = '';
  list.forEach((s) => {
    const el = document.createElement('div');
    el.className = 'song';
    const SRC_LABEL = { qq: 'QQ', qishui: '汽水', xy: '小宇宙' };
    const tag = s.provider && s.provider !== 'netease' ? `<span class="src-tag">${SRC_LABEL[s.provider] || s.provider}${s.isPodcast ? ' · 播客' : ''}</span>` : '';
    el.innerHTML = `
      <div class="song-idx">♥</div>
      <img src="${coverUrl(s.cover) || 'icon.svg'}" loading="lazy" alt="">
      <div class="meta">
        <div class="name">${escapeHtml(s.name)}</div>
        <div class="artist">${escapeHtml(s.artist)}${s.fee === 1 ? ' · VIP' : ''}${tag}</div>
      </div>`;
    el.addEventListener('click', () => { state.queue.push(s); renderQueue(); playIndex(state.queue.length - 1); });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); toggleCollect(s); });
    box.appendChild(el);
  });
}

/* ---------- 时钟与日期 ---------- */
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
function tickClock() {
  const n = new Date();
  $('home-date').textContent = `${n.getFullYear()} 年 ${n.getMonth() + 1} 月 ${n.getDate()} 日 · 星期${WEEK[n.getDay()]}`;
  $('home-clock').textContent = `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`;
  $('stat-date').textContent = `${n.getMonth() + 1}月${n.getDate()}日`;
}
setInterval(tickClock, 1000); tickClock();

/* ---------- 今日聆听统计 ---------- */
function getStats() {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const s = JSON.parse(localStorage.getItem('ew_stats') || 'null');
    if (s && s.date === today) return s;
  } catch { /* ignore */ }
  return { date: today, sec: 0, cnt: 0, last: '' };
}
function saveStats(s) { try { localStorage.setItem('ew_stats', JSON.stringify(s)); } catch { /* ignore */ } }
let _statTick = 0;
function bumpStats(song) {
  const s = getStats();
  s.cnt += 1; s.last = song.name || '';
  saveStats(s); paintStats(s);
}
function tickStats() {
  if (!state.playing) return;
  const now = Date.now();
  if (_statTick && now - _statTick < 5000) return;   // 5 秒一计，防拖动进度虚增
  const delta = _statTick ? Math.min(5, (now - _statTick) / 1000) : 0;
  _statTick = now;
  if (!delta) return;
  const s = getStats();
  s.sec += delta;
  saveStats(s);
  if (Math.floor(s.sec) % 15 < 5) paintStats(s);
}
setInterval(() => { _statTick = 0; }, 10000);   // 暂停后重新计时
function paintStats(s) {
  $('stat-min').textContent = Math.round(s.sec / 60);
  $('stat-cnt').textContent = s.cnt;
  $('stat-last').textContent = s.last || '等待记录';
}
paintStats(getStats());

/* ---------- 音量 ---------- */
audio.volume = Math.min(1, Math.max(0, Number(localStorage.getItem('ew_vol') ?? 1)));
$('bar-vol').value = Math.round(audio.volume * 100);
$('bar-vol').addEventListener('input', (e) => {
  audio.volume = e.target.value / 100;
  localStorage.setItem('ew_vol', audio.volume);
});

/* ---------- 键盘快捷键 ---------- */
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
    if (e.key === 'Escape') { e.target.blur(); closeSearchDrop(); }
    return;
  }
  if (e.key === 'Escape') { closeSearchDrop(); closeQueue(); closeStage(); return; }
  if (e.code === 'Space') { e.preventDefault(); toggle(); }
  else if (e.code === 'ArrowRight' && e.shiftKey) playIndex(state.index + 1);
  else if (e.code === 'ArrowLeft' && e.shiftKey) playIndex(state.index - 1);
  else if (e.code === 'ArrowRight') audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5);
  else if (e.code === 'ArrowLeft') audio.currentTime = Math.max(0, audio.currentTime - 5);
  else if (e.code === 'ArrowUp') { audio.volume = Math.min(1, audio.volume + .1); $('bar-vol').value = Math.round(audio.volume * 100); localStorage.setItem('ew_vol', audio.volume); }
  else if (e.code === 'ArrowDown') { audio.volume = Math.max(0, audio.volume - .1); $('bar-vol').value = Math.round(audio.volume * 100); localStorage.setItem('ew_vol', audio.volume); }
});

/* ---------- v3 视觉打磨：首页取色 / 指针墨光 / 舞台视差 / 滚动层次 ---------- */
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* 首页取色比舞台更克制：六成琥珀打底，只让封面渗一点点墨色出来 */
function tintHomeCover(src) {
  if (!src) return;
  const img = new Image();
  img.onload = () => {
    try {
      const c = document.createElement('canvas'); c.width = c.height = 16;
      const cx = c.getContext('2d', { willReadFrequently: true });
      cx.drawImage(img, 0, 0, 16, 16);
      const d = cx.getImageData(0, 0, 16, 16).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        const lum = d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114;
        if (d[i + 3] < 40 || lum < 18 || lum > 240) continue;
        r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
      }
      if (!n) return;
      const base = [230, 176, 106];
      const rgb = [r / n, g / n, b / n].map((v, i) => Math.round(v * .4 + base[i] * .6));
      document.documentElement.style.setProperty('--home-ink', rgb.join(','));
    } catch { /* 图不可读时保持琥珀 */ }
  };
  img.src = src;
}

/* 卡片：指针位置驱动径向墨光 */
document.addEventListener('pointermove', (e) => {
  const card = e.target && e.target.closest && e.target.closest('.b-card');
  if (!card) return;
  const r = card.getBoundingClientRect();
  if (!r.width || !r.height) return;
  card.style.setProperty('--mx', (((e.clientX - r.left) / r.width) * 100).toFixed(1) + '%');
  card.style.setProperty('--my', (((e.clientY - r.top) / r.height) * 100).toFixed(1) + '%');
}, { passive: true });

/* 舞台：墨晕随指针轻微反向漂移，形成景深 */
if (!reduceMotion) {
  inkStage.addEventListener('pointermove', (e) => {
    const nx = e.clientX / innerWidth - .5, ny = e.clientY / innerHeight - .5;
    inkCanvas.style.transform = `translate3d(${(nx * -22).toFixed(1)}px, ${(ny * -22).toFixed(1)}px, 0)`;
  }, { passive: true });
  inkStage.addEventListener('pointerleave', () => { inkCanvas.style.transform = ''; });
}

/* 页面滚动后给顶栏一道墨线 */
document.querySelectorAll('.page').forEach(p => p.addEventListener('scroll', () => {
  document.body.classList.toggle('is-scrolled', p.scrollTop > 12);
}, { passive: true }));

/* ---------- 封面兜底 ----------
   音源侧封面偶尔防盗链 / 404，破图会在像素界面里变成刺眼的白条或 alt 文字。
   统一换成品牌那枚 11×11 像素音符，捕获阶段监听，动态插入的图片同样生效。 */
const PX_NOTE_SVG = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 11 11' shape-rendering='crispEdges'><g fill='#e6b06a'><rect x='6' y='1' width='4' height='1'/><rect x='8' y='2' width='2' height='1'/><rect x='8' y='3' width='1' height='1'/><rect x='6' y='1' width='2' height='9'/><rect x='3' y='6' width='5' height='1'/><rect x='2' y='7' width='6' height='1'/><rect x='2' y='8' width='6' height='1'/><rect x='3' y='9' width='5' height='1'/></g></svg>";
const PX_BROKEN_COVER = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(PX_NOTE_SVG);
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!img || img.tagName !== 'IMG' || img.src === PX_BROKEN_COVER) return;
  // 二维码加载失败要交给登录逻辑提示「刷新二维码」，别用占位图把错误盖住
  if (img.closest('.qr-wrap')) return;
  img.classList.add('px-broken');
  img.src = PX_BROKEN_COVER;
}, true);

/* ---------- 启动 ---------- */
renderHist();
renderCollects();
refreshLoginStatus();
loadDiscover();
restoreState();
