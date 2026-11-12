/* ====================================================================
   闻曲 · 像素氛围背景（Ambient Drift）
   --------------------------------------------------------------------
   三条设计边界，改动前请先读：
   1) 默认零联网。本机没有天气数据，「天气」由本机时段推断（自动模式
      每 15 分钟在符合当前时段的候选里缓慢轮换），用户也可手动指定。
      真实天气是可选开关：由本机服务代理 Open-Meteo，需要手动填城市，
      默认关闭，失败静默回退到本机推断。
   2) 不做情绪识别。「心情」是从时段 / 是否播放 / 切歌节奏 / 深夜模式
      推断出的听感节奏，四类都可解释，界面里如实标注，可手动覆盖。
   3) 不抢内容。低对比、screen 混合、18fps、失焦与隐藏页暂停、
      尊重 prefers-reduced-motion、三档强度（含完全关闭）。
   ==================================================================== */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);

  const LS = {
    weather: 'ew_amb_weather',
    mood: 'ew_amb_mood',
    level: 'ew_amb_level',
    real: 'ew_amb_real',
    city: 'ew_amb_city',
  };
  function ls(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  function setls(k, v) { try { localStorage.setItem(k, String(v)); } catch (e) {} }

  /* ---------- 天气 → 粒子形态 ----------
     size: [最短边, 最长边]（mote/star 用正方形，streak 竖线，dash 横线，
     block 大淡块）；坐标统一吸附到 3px 网格，天然得到 8-bit 台阶感。 */
  const WEATHERS = {
    auto:   { label: '自动', glyph: '◌' },
    clear:  { label: '晴',   glyph: '✦', shape: 'mote',   rgb: [230, 176, 106], count: 36, size: [6, 6],    vx: [-.05, .05],   vy: [-.32, -.1],  alpha: .42, twinkle: .5 },
    cloud:  { label: '多云', glyph: '▤', shape: 'block',  rgb: [150, 168, 186], count: 18, size: [24, 48],  vx: [.05, .18],    vy: [-.01, .02],  alpha: .13 },
    rain:   { label: '雨',   glyph: '┊', shape: 'streak', rgb: [128, 170, 200], count: 48, size: [6, 15],   vx: [-.42, -.16],  vy: [1.5, 2.6],   alpha: .46 },
    snow:   { label: '雪',   glyph: '❄', shape: 'flake',  rgb: [226, 232, 238], count: 40, size: [6, 9],    vx: [-.16, .16],   vy: [.35, .8],    alpha: .48 },
    fog:    { label: '雾',   glyph: '≋', shape: 'block',  rgb: [176, 185, 194], count: 16, size: [30, 60],  vx: [.06, .2],     vy: [-.01, .01],  alpha: .11 },
    wind:   { label: '风',   glyph: '→', shape: 'dash',   rgb: [143, 184, 174], count: 30, size: [12, 21],  vx: [.85, 1.6],    vy: [-.04, .04],  alpha: .36 },
    night:  { label: '夜',   glyph: '☾', shape: 'star',   rgb: [246, 205, 147], count: 32, size: [6, 6],    vx: [-.02, .02],   vy: [-.02, .02],  alpha: .44, twinkle: 1 },
  };

  /* 心情只调密度 / 速度 / 色温 / 亮度，不新增粒子形状 */
  const MOODS = {
    auto:     { label: '自动', glyph: '◌' },
    calm:     { label: '静', glyph: '·', density: .72, speed: .72, warm: .05,  alpha: .85 },
    bright:   { label: '亮', glyph: '✦', density: 1.12, speed: 1.12, warm: .3,   alpha: 1.05 },
    mellow:   { label: '柔', glyph: '♩', density: .9,  speed: .86, warm: .42,  alpha: .92 },
    restless: { label: '跳', glyph: '»', density: 1.2, speed: 1.5, warm: -.12, alpha: 1 },
  };
  const LEVELS = { off: 0, low: .9, normal: 1.4 };
  const LEVEL_LABEL = { off: '关', low: '轻', normal: '标准' };

  const cfg = {
    weather: WEATHERS[ls(LS.weather, 'auto')] ? ls(LS.weather, 'auto') : 'auto',
    mood: MOODS[ls(LS.mood, 'auto')] ? ls(LS.mood, 'auto') : 'auto',
    level: LEVELS[ls(LS.level, 'low')] != null ? ls(LS.level, 'low') : 'low',
    real: ls(LS.real, '0') === '1',
    city: ls(LS.city, ''),
  };

  let canvas = null, ctx = null, W = 0, H = 0;
  let parts = [], raf = 0, lastFrame = 0, paused = false;
  let reduce = false, playing = false, swaps = [], lastSong = '';
  let realInfo = null, realErr = '', lastRealAt = 0;
  let effective = 'clear', effectiveMood = 'calm', note = '';
  let cur = null, target = null, lastShapeKey = '';

  const midnight = () => document.body.classList.contains('midnight');
  const GRID = 3;
  const snap = (v) => Math.round(v / GRID) * GRID;
  const snapSize = (v) => Math.max(GRID, snap(v));

  /* ---------- 本机信号 ---------- */
  function readPlaying() {
    try {
      const g = window.EW && EW.audio && EW.audio();
      if (g && g.analyser) {
        const buf = new Uint8Array(g.analyser.frequencyBinCount);
        g.analyser.getByteFrequencyData(buf);
        let s = 0, n = 0;
        for (let i = 0; i < buf.length; i += 8) { s += buf[i]; n++; }
        return n ? (s / n) > 3 : false;
      }
    } catch (e) {}
    const a = document.querySelector('audio');
    return !!(a && !a.paused && !a.ended);
  }

  function pollSong() {
    try {
      const s = window.EW && EW.current && EW.current();
      const id = s ? String(s.id || s.name || '') : '';
      if (id && lastSong && id !== lastSong) swaps.push(Date.now());
      if (id) lastSong = id;
    } catch (e) {}
    const cut = Date.now() - 10 * 60 * 1000;
    swaps = swaps.filter((t) => t > cut);
  }

  /* 自动天气：只从本机时钟推断，时段内每 15 分钟缓慢轮换，不假装知道外面下没下雨 */
  function localWeather() {
    const d = new Date(), h = d.getHours();
    const slot = Math.floor(d.getTime() / (15 * 60 * 1000));
    let pool;
    if (midnight() || h < 5 || h >= 23) pool = ['night', 'night', 'cloud'];
    else if (h < 9) pool = ['clear', 'clear', 'wind'];
    else if (h < 17) pool = ['clear', 'wind', 'cloud'];
    else if (h < 20) pool = ['cloud', 'clear', 'wind'];
    else pool = ['night', 'cloud', 'night'];
    return pool[slot % pool.length];
  }

  /* 自动心情：可解释的四类，不是情绪识别 */
  function localMood() {
    const h = new Date().getHours();
    if (swaps.length >= 6) return 'restless';
    if (midnight() || h < 6) return 'calm';
    if (!playing) return 'mellow';
    if (h >= 6 && h < 11) return 'bright';
    if (h >= 11 && h < 18) return swaps.length >= 3 ? 'restless' : 'bright';
    return 'mellow';
  }

  function mixedRgb(rgb, warm) {
    const to = warm >= 0 ? [246, 205, 147] : [128, 170, 200];
    return rgb.map((c, i) => lerp(c, to[i], Math.abs(warm) * .4));
  }

  /* ---------- 目标参数（每帧缓动，切换不跳色不跳速） ---------- */
  function recalc() {
    const wKey = cfg.weather === 'auto'
      ? (cfg.real && realInfo && realInfo.weather ? realInfo.weather : localWeather())
      : cfg.weather;
    effective = WEATHERS[wKey] ? wKey : 'clear';
    effectiveMood = cfg.mood === 'auto' ? localMood() : cfg.mood;

    const w = WEATHERS[effective], m = MOODS[effectiveMood] || MOODS.calm;
    const lv = LEVELS[cfg.level] == null ? LEVELS.low : LEVELS[cfg.level];
    const area = clamp((W * H) / (1440 * 900), .5, 1.25);
    const night = midnight() ? .78 : 1;
    const rgb = mixedRgb(w.rgb, m.warm);

    target = {
      r: rgb[0], g: rgb[1], b: rgb[2],
      alpha: w.alpha * m.alpha * lv,
      speed: m.speed * (playing ? 1.08 : 1),
      count: cfg.level === 'off' ? 0
        : Math.round(w.count * m.density * (lv ? clamp(lv, .7, 1.4) : 0) * area * night),
      shape: w.shape,
    };
    if (!cur) cur = Object.assign({}, target);

    // 换天气要「马上看得出」：现有粒子保留位置，但立刻换成新形态与新速度。
    // 若等到它们自然飘出屏幕，慢速天气（晴 / 夜）可能要几分钟才变色。
    if (lastShapeKey && lastShapeKey !== effective) restyleParts();
    lastShapeKey = effective;

    note = cfg.weather !== 'auto'
      ? '手动指定天气 · 本机渲染'
      : cfg.real
        ? (realInfo ? `真实天气 · ${realInfo.city || cfg.city} · ${WEATHERS[effective] ? WEATHERS[effective].label : effective}`
          : (realErr || '天气服务暂不可用 · 已回退本机推断'))
        : '本机推断 · 不出网';
    syncUI();
  }

  /* ---------- 粒子 ---------- */
  function shapeSize(shape, size) {
    const a = snapSize(size[0]), b = snapSize(size[1]);
    const v = snapSize(rand(Math.min(a, b), Math.max(a, b)));
    if (shape === 'streak') return { pw: a, ph: v };       // 竖雨丝
    if (shape === 'dash') return { pw: v, ph: a };          // 横风痕
    if (shape === 'block') return { pw: v, ph: snapSize(rand(a, Math.max(a, b))) };
    return { pw: v, ph: v };                                // 光尘 / 雪花 / 星点
  }

  function makePart(initial) {
    const s = WEATHERS[effective];
    const sz = shapeSize((cur && cur.shape) || s.shape, s.size);
    const p = {
      x: initial ? rand(0, W) : (s.vx[0] >= 0 ? -sz.pw - 10 : rand(0, W)),
      y: initial ? rand(0, H) : (s.vy[0] >= 0 ? -sz.ph - 10 : H + 10),
      pw: sz.pw, ph: sz.ph,
      vx: rand(s.vx[0], s.vx[1]), vy: rand(s.vy[0], s.vy[1]),
      a: rand(.7, 1.1), phase: rand(0, Math.PI * 2),
      born: effective,
    };
    // 初始态要把「从上方落下」的粒子铺满整屏，别等 10 秒才看见东西
    if (!initial) {
      if (s.vy[0] >= 0) p.y = -sz.ph - 10;
      else if (s.vy[1] <= 0) p.y = H + 10;
      if (s.vx[0] >= 0) p.x = -sz.pw - 10;
      else if (s.vx[1] <= 0) p.x = W + 10;
    }
    return p;
  }

  function restyleParts() {
    const s = WEATHERS[effective];
    for (const p of parts) {
      const sz = shapeSize(s.shape, s.size);
      p.pw = sz.pw; p.ph = sz.ph;
      p.vx = rand(s.vx[0], s.vx[1]);
      p.vy = rand(s.vy[0], s.vy[1]);
      p.born = effective;
    }
  }

  function resize() {
    if (!canvas) return;
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    parts = Array.from({ length: target ? target.count : 24 }, () => makePart(true));
    recalc();
  }

  function frame(t, frozen) {
    if (!ctx) return;
    if (!frozen) for (const k in target) {
      if (typeof target[k] === 'number') cur[k] = lerp(cur[k], target[k], .075);
      else cur[k] = target[k];
    } else Object.assign(cur, target);

    // 数量也渐变：一帧最多增减 1 个，避免切天气时整屏闪一下
    const want = clamp(Math.round(cur.count), 0, 64);
    if (parts.length < want) parts.push(makePart(false));
    else if (parts.length > want) parts.pop();

    ctx.clearRect(0, 0, W, H);
    const dt = frozen ? 0 : clamp((t - lastFrame) / 55, .3, 2.2);
    const breath = frozen ? 1 : (.92 + .08 * Math.sin(t / 3200));
    ctx.fillStyle = `rgb(${cur.r | 0},${cur.g | 0},${cur.b | 0})`;

    for (const p of parts) {
      p.x += p.vx * cur.speed * dt;
      p.y += p.vy * cur.speed * dt;
      const off = p.y > H + 30 || p.y < -60 || p.x > W + 60 || p.x < -80;
      if (off && !frozen) {
        // 离屏后用「当前」天气重生 → 形态自然过渡，旧粒子慢慢走完
        const np = makePart(false);
        Object.assign(p, np);
      }
      const tw = WEATHERS[effective].twinkle
        ? (.62 + .38 * Math.sin(t / 900 + p.phase)) : 1;
      ctx.globalAlpha = clamp(cur.alpha * p.a * breath * tw, 0, .5);
      ctx.fillRect(snap(p.x), snap(p.y), p.pw, p.ph);
    }
    ctx.globalAlpha = 1;
  }

  function loop(t) {
    raf = requestAnimationFrame(loop);
    if (t - lastFrame < 55) return;   // ≈18fps
    frame(t, false);
    lastFrame = t;
  }

  function start() {
    if (!canvas || raf || cfg.level === 'off' || paused) return;
    if (reduce) {
      // 减弱动效：一次性铺满整屏，只画这一帧静态画面，之后不再跑 rAF
      const want = clamp(Math.round(target.count), 0, 64);
      while (parts.length < want) parts.push(makePart(true));
      frame(0, true);
      return;
    }
    lastFrame = 0;
    raf = requestAnimationFrame(loop);
  }
  function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }

  function restart() {
    stop();
    if (canvas) canvas.hidden = cfg.level === 'off';
    if (cfg.level === 'off') { if (ctx) ctx.clearRect(0, 0, W, H); return; }
    start();
  }

  /* ---------- 真实天气（可选 · 本机服务代理） ---------- */
  function api(path) {
    return fetch(path, { headers: { Accept: 'application/json' } })
      .then((r) => r.json());
  }
  async function refreshReal(force) {
    if (!cfg.real) { realInfo = null; realErr = ''; recalc(); return; }
    if (!cfg.city.trim()) {
      realInfo = null; realErr = '填了城市才取真实天气 · 已回退本机推断';
      recalc(); return;
    }
    if (!force && realInfo && Date.now() - lastRealAt < 30 * 60 * 1000) return;
    try {
      const r = await api('/api/ambient/weather?city=' + encodeURIComponent(cfg.city.trim()));
      if (r && r.ok && WEATHERS[r.weather]) {
        realInfo = r; realErr = ''; lastRealAt = Date.now();
      } else {
        realInfo = null; realErr = '天气暂时取不到 · 已回退本机推断';
      }
    } catch (e) {
      realInfo = null; realErr = '天气服务连不上 · 已回退本机推断';
    }
    recalc();
  }

  /* ---------- 设置面板 ---------- */
  function syncUI() {
    const chip = $('amb-chip');
    const wLabel = WEATHERS[effective] ? WEATHERS[effective].label : effective;
    if (chip) {
      chip.textContent = (WEATHERS[effective] ? WEATHERS[effective].glyph : '◌') + ' ' + wLabel;
      chip.title = `氛围背景 · ${wLabel} / ${MOODS[effectiveMood] ? MOODS[effectiveMood].label : effectiveMood} · ${note}（点击设置）`;
      chip.setAttribute('aria-label', chip.title);
    }
    const status = $('amb-status');
    if (status) status.textContent = `当前 ${wLabel} · ${MOODS[effectiveMood] ? MOODS[effectiveMood].label : effectiveMood} · ${LEVEL_LABEL[cfg.level]}　|　${note}`;
    document.querySelectorAll('[data-amb-w]').forEach((b) => b.classList.toggle('is-on', b.dataset.ambW === cfg.weather));
    document.querySelectorAll('[data-amb-m]').forEach((b) => b.classList.toggle('is-on', b.dataset.ambM === cfg.mood));
    document.querySelectorAll('[data-amb-l]').forEach((b) => b.classList.toggle('is-on', b.dataset.ambL === cfg.level));
    const real = $('amb-real'), city = $('amb-city'), rn = $('amb-real-note');
    if (real) real.checked = cfg.real;
    // 只在面板打开且输入框没在编辑时回填，别把用户正在打的城市名冲掉
    const mask = $('amb-mask');
    if (city && mask && !mask.hidden && document.activeElement !== city && city.value !== cfg.city) city.value = cfg.city;
    if (rn) {
      rn.textContent = !cfg.real
        ? '关闭时完全不出网；开启后由本机服务代理请求 Open-Meteo，30 分钟缓存一次。'
        : (realInfo
          ? `已取到 ${realInfo.city || cfg.city}：${realInfo.temp != null ? realInfo.temp + '°C · ' : ''}${WEATHERS[realInfo.weather] ? WEATHERS[realInfo.weather].label : realInfo.weather}`
          : (realErr || '正在取天气…'));
    }
  }

  function openPanel() {
    const m = $('amb-mask');
    if (!m) return;
    m.hidden = false;
    syncUI();
  }
  function closePanel() { const m = $('amb-mask'); if (m) m.hidden = true; }

  function setWeather(v) {
    if (!WEATHERS[v]) return;
    cfg.weather = v; setls(LS.weather, v);
    // 手选天气优先于真实天气：避免「选了雨却一直显示晴」
    if (v !== 'auto') { realInfo = null; realErr = '手动指定天气 · 本机渲染'; }
    recalc();
  }
  function setMood(v) { if (!MOODS[v]) return; cfg.mood = v; setls(LS.mood, v); recalc(); }
  function setLevel(v) { if (LEVELS[v] == null) return; cfg.level = v; setls(LS.level, v); recalc(); restart(); }

  function bindUI() {
    const chip = $('amb-chip');
    if (chip) chip.addEventListener('click', openPanel);
    const mask = $('amb-mask');
    if (mask) mask.addEventListener('click', (e) => { if (e.target === mask) closePanel(); });
    const close = $('amb-close');
    if (close) close.addEventListener('click', closePanel);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && mask && !mask.hidden) { e.stopPropagation(); closePanel(); }
    }, true);

    document.querySelectorAll('[data-amb-w]').forEach((b) => b.addEventListener('click', () => setWeather(b.dataset.ambW)));
    document.querySelectorAll('[data-amb-m]').forEach((b) => b.addEventListener('click', () => setMood(b.dataset.ambM)));
    document.querySelectorAll('[data-amb-l]').forEach((b) => b.addEventListener('click', () => setLevel(b.dataset.ambL)));

    const real = $('amb-real');
    if (real) real.addEventListener('change', () => {
      cfg.real = !!real.checked; setls(LS.real, cfg.real ? '1' : '0');
      realInfo = null; realErr = ''; lastRealAt = 0;
      recalc();
      if (cfg.real) refreshReal(true);
    });
    const save = $('amb-city-save');
    if (save) save.addEventListener('click', () => {
      const city = $('amb-city');
      cfg.city = city ? city.value.trim() : '';
      setls(LS.city, cfg.city);
      realInfo = null; lastRealAt = 0;
      recalc();
      if (cfg.real) refreshReal(true);
    });
  }

  /* ---------- 慢轮询：2s 一次，不进渲染帧 ---------- */
  let slowTick = 0;
  function slow() {
    playing = readPlaying();
    pollSong();
    slowTick += 1;
    if (slowTick % 8 === 0) recalc();                       // 16s：时段 / 心情 / 播放态
    if (cfg.real && Date.now() - lastRealAt >= 30 * 60 * 1000) refreshReal(false);
  }

  function init() {
    canvas = $('px-drift');
    if (!canvas || !canvas.getContext) return;
    ctx = canvas.getContext('2d');
    reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    bindUI();
    recalc();          // 先算出 cur / target，makePart 才能拿到粒子形状
    resize();          // resize 内部会按真实窗口尺寸再算一次
    restart();

    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', () => {
      paused = document.hidden;
      if (paused) stop(); else restart();
    });
    window.addEventListener('blur', () => { paused = true; stop(); });
    window.addEventListener('focus', () => { paused = false; restart(); });
    document.addEventListener('ew:page', () => setTimeout(recalc, 60));
    setInterval(slow, 2000);
    if (cfg.real) refreshReal(true);
  }

  /* ---------- 命令面板接口 ---------- */
  function commands() {
    // 命令面板只放高频切换；八种天气 / 五种心情的完整细项在设置面板里，
    // 免得 ⌘K 初始列表被几十条氛围命令淹没。
    return [
      { t: '打开氛围背景设置（天气 / 心情 / 强度）', g: '◌', run: openPanel },
      { t: '氛围天气：自动（本机时段推断）', g: '◌', run: () => setWeather('auto') },
      { t: '氛围天气：晴 · 暖金光尘', g: '✦', run: () => setWeather('clear') },
      { t: '氛围天气：雨 · 斜落雨丝', g: '┊', run: () => setWeather('rain') },
      { t: '氛围天气：雪 · 慢飘雪块', g: '❄', run: () => setWeather('snow') },
      { t: '氛围心情：自动（听歌节奏）', g: '♩', run: () => setMood('auto') },
      { t: '背景强度：轻（默认）', g: '▦', run: () => setLevel('low') },
      { t: '背景强度：关', g: '×', run: () => setLevel('off') },
      { t: '刷新真实天气（需已开启并填城市）', g: '↻', run: () => refreshReal(true) },
    ];
  }

  window.Ambient = {
    commands,
    open: openPanel,
    close: closePanel,
    setWeather, setMood, setLevel,
    refresh: () => { recalc(); restart(); },
    debug: () => ({
      weather: effective, mood: effectiveMood, level: cfg.level,
      note, parts: parts.length, want: target && target.count,
      reduce, paused, playing, real: !!cfg.real, city: cfg.city,
      realInfo: realInfo ? { city: realInfo.city, weather: realInfo.weather, temp: realInfo.temp } : null,
      swaps: swaps.length, raf: !!raf,
    }),
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
