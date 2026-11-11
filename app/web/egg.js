/* ====================================================================
   闻曲 · 登录彩蛋（全屏像素演出）
   ------------------------------------------------------------------
   流程：登录成功 → 全屏暗号门 → 输入四字暗号 → 服务端校验
        → 四幕 8-bit 分镜（全屏）+ 芯片音效 → 落版 → 继续听歌
   两套场景：首次登录「初次相遇」／退出后重登「久别重逢」

   画布按视口动态计算逻辑分辨率，场景以 192×108 设计坐标绘制并等比
   居中铺满；只用 fillRect 画整块像素，CSS 放大时关闭插值，保证硬边。
   ==================================================================== */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const C = {
    bg: '#070911', sky0: '#101728', sky1: '#151d33', sky2: '#1b2540', sky3: '#222e4a',
    deep: '#1a2334', panel: '#2b3548', line: '#3b485f', txt: '#eae4d6', dim: '#98a0a8',
    amber: '#e6b06a', amberHi: '#f6cd93', amberDim: '#8a683c', red: '#d1483a',
    green: '#8fb8ae', greenHi: '#bfe0d5', blue: '#5f83b0', purple: '#8b6fae',
    skin: '#f0c9a0', hair: '#3a2b22', dark: '#111319', warm: '#6f5432',
    white: '#fff3d8',
  };
  const W = 192, H = 108, GROUND = 88;
  const FPS = 12, TOTAL = 84;
  const ACTS = [0, 18, 42, 66, TOTAL];   // 静 / 起 / 潮 / 落
  const IDLE_END = 18;

  /* ---------- 本机彩蛋接口：同源、带超时，绕开全局 api() 的云端前缀 ---------- */
  function get(p) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    return fetch(p, { signal: ctl.signal }).then(r => r.json()).finally(() => clearTimeout(t));
  }
  function post(p, body) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    return fetch(p, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}), signal: ctl.signal,
    }).then(r => r.json()).finally(() => clearTimeout(t));
  }

  /* ---------- 全屏像素画笔 ---------- */
  let ctx = null, canvas = null;
  let CW = 192, CH = 108, U = 1, VW = W, VH = H, OX = 0, OY = 0, SCALE = 4;
  let shakeX = 0, shakeY = 0, STARS = [];

  function resize() {
    if (!canvas || !ctx) return;
    const vw = Math.max(320, window.innerWidth), vh = Math.max(240, window.innerHeight);
    SCALE = Math.max(2, Math.min(10, Math.round(Math.min(vw / W, vh / H))));
    CW = Math.ceil(vw / SCALE); CH = Math.ceil(vh / SCALE);
    U = Math.min(CW / W, CH / H);
    VW = CW / U; VH = CH / U;
    OX = (VW - W) / 2; OY = (VH - H) / 2;
    canvas.width = CW; canvas.height = CH;
    STARS = Array.from({ length: Math.max(40, Math.round(VW * .55)) }, (_, i) => ({
      x: -OX + rnd(i + 3) * VW,
      y: -OY + rnd(i + 71) * (70 + OY),
      tier: i % 3,
    }));
  }
  function rnd(seed) { const v = Math.sin(seed * 12.9898) * 43758.5453; return v - Math.floor(v); }
  function px(x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(
      Math.round((x + OX) * U) + shakeX, Math.round((y + OY) * U) + shakeY,
      Math.max(1, Math.round(w * U)), Math.max(1, Math.round(h * U))
    );
  }
  function band(y, h, color) {  // 全屏横向色带（带过扫，抖动时不露边）
    ctx.fillStyle = color;
    ctx.fillRect(-4, Math.round((y + OY) * U) + shakeY, CW + 8, Math.max(1, Math.round(h * U)));
  }
  function bg(color) { ctx.fillStyle = color; ctx.fillRect(0, 0, CW, CH); }
  function veil(alpha) { ctx.fillStyle = `rgba(3,4,8,${alpha})`; ctx.fillRect(0, 0, CW, CH); }

  function note(x, y, c, big) {
    const s = big ? 1.5 : 1;
    px(x, y + 2 * s, 3 * s, 2 * s, c); px(x + 3 * s, y, 1 * s, 5 * s, c);
    px(x + 4 * s, y, 2 * s, 1 * s, c);
  }
  function spark(x, y, c, s) {
    const k = s || 1;
    px(x - k, y, k * 3, k, c); px(x, y - k, k, k * 3, c);
  }
  function hero(x, groundY, pose, coat, scale) {
    const s = scale || 1;
    const p = (dx, dy, w, h, c) => px(x + dx * s, groundY + dy * s, w * s, h * s, c);
    p(-1, -1, 10, 1, 'rgba(0,0,0,.5)');                       // 影
    p(1, -13, 6, 2, C.hair);                                   // 头发
    p(1, -11, 6, 4, C.skin);                                   // 脸
    p(2, -10, 1, 1, C.dark); p(5, -10, 1, 1, C.dark);          // 眼
    p(3, -8, 2, 1, C.red);                                     // 嘴
    p(1, -7, 6, 5, coat);                                      // 身
    p(3, -7, 2, 2, C.amber);                                   // 领口
    if (pose === 2) { p(-1, -10, 2, 2, C.skin); p(7, -10, 2, 2, C.skin); }
    else if (pose === 3) { p(-1, -6, 2, 2, C.skin); p(7, -11, 2, 3, C.skin); }
    else if (pose === 4) { p(-1, -6, 2, 2, C.skin); p(7, -9, 2, 3, C.skin); }
    else if (pose === 1) { p(-1, -7, 2, 2, C.skin); p(7, -6, 2, 2, C.skin); }
    else { p(-1, -6, 2, 2, C.skin); p(7, -6, 2, 2, C.skin); }
    p(1, -2, 2, 2, C.dark); p(5, -2, 2, 2, C.dark);            // 脚
  }

  function sky(f, warm) {
    bg(C.bg);
    const top = -OY - 2;
    band(top, 24, C.sky0); band(top + 24, 20, C.sky1);
    band(top + 44, 20, C.sky2); band(top + 64, H + OY * 2 + 10, C.sky3);
    STARS.forEach((s, i) => {
      if ((f + i * 2) % 9 < (s.tier === 0 ? 8 : s.tier === 1 ? 6 : 4)) {
        px(s.x, s.y, 1, 1, s.tier === 0 ? (warm ? C.amberHi : C.white) : C.dim);
      }
    });
    nebula(f); clouds(f);
  }
  /* 斜向像素星云带：给上半屏铺一层色彩，避免大片空黑 */
  function nebula(f) {
    for (let i = 0; i < 30; i++) {
      const x = -OX + ((i * 13 + f * .22) % (VW + 30)) - 15;
      const y = 14 + Math.sin(i * .62) * 8 + (i % 3) * 3;
      const c = i % 3 === 0 ? 'rgba(139,111,174,.16)'
        : i % 3 === 1 ? 'rgba(95,131,176,.13)' : 'rgba(230,176,106,.10)';
      px(x, y, 9 + (i % 4) * 3, 2 + (i % 2) * 2, c);
    }
  }
  function clouds(f) {
    for (let i = 0; i < 9; i++) {
      const x = -OX + ((i * 31 + f * .16) % (VW + 50)) - 25;
      const y = 9 + (i % 5) * 8;
      px(x, y, 13, 2, 'rgba(150,170,205,.13)');
      px(x + 4, y - 2, 7, 2, 'rgba(150,170,205,.09)');
      px(x + 2, y + 2, 8, 1, 'rgba(150,170,205,.07)');
    }
  }
  function hills(f, near) {
    const off = (f * .12) % 12;
    for (let i = -2; i < Math.ceil(VW / 14) + 2; i++) {
      const x = -OX + i * 14 - off;
      const h = 8 + Math.abs(Math.sin(i * 1.7)) * 11;
      px(x, GROUND - h, 14, h, near ? '#141c2b' : '#1b2639');
      px(x, GROUND - h, 14, 1, near ? '#26344b' : '#2b3b55');
      if (near && i % 4 === 0) px(x + 4, GROUND - h - 3, 2, 2, C.amberDim);
    }
  }
  /* 透视网格地面：80 年代像素风，把下半屏填满 */
  function grid(warm) {
    const horizon = GROUND, bottom = H + OY + 4;
    const line = warm ? 'rgba(230,176,106,.26)' : 'rgba(120,165,220,.22)';
    const ray = warm ? 'rgba(230,176,106,.15)' : 'rgba(120,165,220,.13)';
    for (let i = 1; i <= 6; i++) {
      const y = horizon + Math.pow(i / 6, 1.7) * (bottom - horizon);
      band(y, .6, line);
    }
    for (let i = -7; i <= 7; i++) {
      const xTop = 96 + i * 2.4, xBot = 96 + i * (VW / 8);
      for (let k = 1; k <= 7; k++) {
        const t = k / 7;
        px(xTop + (xBot - xTop) * t, horizon + Math.pow(t, 1.7) * (bottom - horizon), 1, 1.6, ray);
      }
    }
  }
  function ground(warm) {
    band(GROUND, H - GROUND + OY + 4, '#0a0e18');
    grid(warm);
    band(GROUND, 1.2, warm ? C.amberHi : '#6f9fd0');
    for (let i = 0; i < Math.ceil(VW / 9); i++) {
      const x = -OX + (i * 11 + 3) % VW;
      px(x, 94 + (i % 3) * 4, 4, 1, warm ? C.warm : C.panel);
    }
  }
  /* 大像素月亮（久别重逢的氛围锚点） */
  function moon(f) {
    const cx = 34, cy = 22, r = 10;
    for (let i = 3; i >= 1; i--) {
      const rr = r + i * 2;
      for (let dy = -rr; dy <= rr; dy += 2) {
        const w = Math.floor(Math.sqrt(Math.max(0, rr * rr - dy * dy)));
        px(cx - w, cy + dy, w * 2, 1, `rgba(246,205,147,${.035 * (4 - i)})`);
      }
    }
    for (let dy = -r; dy <= r; dy++) {
      const w = Math.floor(Math.sqrt(Math.max(0, r * r - dy * dy)));
      px(cx - w, cy + dy, w * 2, 1, dy > 5 ? C.amber : C.amberHi);
    }
    px(cx - 5, cy - 4, 3, 2, C.amberDim); px(cx + 2, cy + 3, 4, 2, C.amberDim);
    if (f > 20) { spark(16, 12, C.white, 1); spark(52, 34, C.amberHi, 1); }
  }
  /* 带环的行星（初次相遇的氛围锚点） */
  function planet(f) {
    const cx = 150, cy = 24, r = 11;
    for (let dy = -r; dy <= r; dy++) {
      const w = Math.floor(Math.sqrt(Math.max(0, r * r - dy * dy)));
      px(cx - w, cy + dy, w * 2, 1, dy < -4 ? '#9a7bbd' : dy > 5 ? '#4d6b96' : '#bd9fd0');
    }
    px(cx - 16, cy + 4, 32, 1, C.amberDim);
    px(cx - 13, cy + 5, 26, 1, C.amber);
    px(cx - 9, cy + 6, 18, 1, C.amberDim);
    if (f % 12 < 6) spark(cx + 16, cy - 9, C.white, 1);
  }
  /* 大像素烟花：高潮幕的视觉爆点 */
  function fireworks(f, cx, cy, colors, delay) {
    const t = (f - 42 - (delay || 0)) % 15;
    if (t < 0 || t > 10) return;
    const r = t * 2.1;
    for (let i = 0; i < 12; i++) {
      const a = i * Math.PI * 2 / 12;
      px(cx + Math.cos(a) * r, cy + Math.sin(a) * r * .8, 2, 2, colors[i % colors.length]);
      if (t > 3) px(cx + Math.cos(a) * (r - 5), cy + Math.sin(a) * (r - 5) * .8, 1, 1, colors[(i + 3) % colors.length]);
    }
    if (t < 4) px(cx - 2, cy - 2, 4, 4, C.white);
  }
  function portalRipple(cx, cy, f, color) {
    for (let i = 0; i < 4; i++) {
      const d = ((f - i * 5) % 24 + 24) % 24;
      if (d > 2 && d < 20) {
        const s = d * 1.6;
        px(cx - s, cy - s * .7, 2, 2, color); px(cx + s, cy - s * .7, 2, 2, color);
        px(cx - s, cy + s * .7, 2, 2, color); px(cx + s, cy + s * .7, 2, 2, color);
      }
    }
  }
  function confetti(f, wave) {
    const colors = [C.amber, C.red, C.green, C.blue, C.amberHi, C.purple, C.white];
    for (let w = 0; w < 2; w++) {
      const start = 42 + w * 9;
      if (f < start) continue;
      const d = (f - start) * (w ? 3.4 : 2.7);
      const oy = w ? 58 : 34;
      for (let i = 0; i < 20; i++) {
        const a = i * Math.PI * 2 / 20 + w * .15;
        const nx = 96 + Math.cos(a) * d, ny = oy + Math.sin(a) * d * .72 + (f - start) * (f - start) * .045;
        if (nx > -OX && nx < VW - OX && ny > -OY && ny < GROUND - 1) {
          px(nx, ny, 2, 2, colors[(i + w) % colors.length]);
        }
      }
    }
    if (wave) for (let i = 0; i < 9; i++) {
      const x = -OX + rnd(i + 9) * VW;
      const y = GROUND - ((f * 1.6 + i * 11) % 78);
      if (y > -OY + 4) spark(x, y, i % 2 ? C.greenHi : C.amberHi, 1);
    }
  }

  /* ---------- 场景 01 · 初次相遇：星空 → 传送门 → 出走 → 礼花 ---------- */
  function drawFirst(f) {
    const act = actOf(f);
    sky(f, act >= 2);
    planet(f);
    hills(f, false); hills(Math.floor(f * .6), true);
    const lit = act >= 2;
    ground(lit);
    if (act >= 1) portalRipple(96, 62, f, act >= 2 ? C.amberHi : C.blue);

    // 传送门：逐幕展开、门内像素漩涡、边框流光
    const target = act === 0 ? 0 : act === 1 ? Math.min(44, (f - 18) * 2) : 44;
    const open = Math.max(0, target);
    if (open > 1) {
      const l = 96 - open / 2, r = 96 + open / 2;
      px(l + 2, 38, Math.max(1, open - 4), 50, 'rgba(8,7,18,.62)');
      for (let y = 42; y < 87; y += 4) {
        for (let x = l + 2; x < r - 2; x += 3) {
          if ((x + y + f) % 5 < 3) px(x, y, 2, 2, (x + y + f) % 7 < 3 ? C.purple : C.blue);
        }
      }
      px(l, 38, 3, 50, C.amber); px(r - 3, 38, 3, 50, C.amber);
      px(l, 38, open, 3, C.amberHi); px(l, 85, open, 3, C.amberDim);
      px(l - 3, 35, 6, 3, C.amberHi); px(r - 3, 35, 6, 3, C.amberHi);
      const glow = (f % 12) * 3;
      px(l, 38 + glow, 3, 4, C.white); px(r - 3, 82 - glow, 3, 4, C.white);
      if (act >= 2) {
        for (let i = 0; i < 7; i++) {
          const yy = 42 + ((f * 2 + i * 9) % 44);
          px(l + 4 + ((f + i * 7) % Math.max(4, open - 8)), yy, 2, 2, C.white);
        }
      }
    } else {
      const pulse = f % 8 < 4 ? C.amberHi : C.amberDim;
      px(92, 60, 8, 8, pulse); spark(96, 64, C.amber, 3);
    }

    // 小人：从门里走出来 → 站定 → 挥手（放大到 1.6 倍，全屏下才看得清）
    if (act >= 1) {
      const t = Math.min(1, (f - 26) / 20);
      const hx = Math.round(88 - t * 30);
      hero(hx, GROUND, act >= 2 ? (f % 4 < 2 ? 2 : 3) : (f % 4 < 2 ? 0 : 1), C.green, 1.6);
    }
    // 音符升起 + 双朵大烟花
    if (act >= 2) {
      const rise = (f - 42) * 1.3;
      note(30 + Math.sin(f / 5) * 3, 84 - rise, C.amber, true);
      note(152 - Math.sin(f / 4) * 3, 84 - rise * .8, C.amberHi, true);
      note(120 + Math.sin(f / 6) * 2, 84 - rise * .6, C.greenHi);
      const colors = [C.amber, C.red, C.greenHi, C.blue, C.amberHi, C.purple, C.white];
      fireworks(f, 42, 30, colors, 0);
      fireworks(f, 152, 40, colors, 7);
    }
    if (act >= 2) confetti(f, false);
    if (act === 3) {
      for (let i = 0; i < 9; i++) px(62 + i * 9, 18 + (f % 3), 4, 62, 'rgba(246,205,147,.10)');
      for (let i = 0; i < 20; i++) {
        const x = -OX + rnd(i + 31) * VW;
        const y = 12 + ((f * .8 + i * 7) % 72);
        px(x, y, 1, 1, i % 2 ? C.amberHi : C.white);
      }
      veil(.16);
    }
  }

  /* ---------- 场景 02 · 久别重逢：夜屋 → 亮灯 → 唱片 → 星雨 ---------- */
  function drawReturn(f) {
    const act = actOf(f);
    sky(f, act >= 1);
    moon(f);
    hills(f, false); hills(Math.floor(f * .6), true);
    const lit = act >= 1;
    ground(lit);

    // 小屋：放大到画面主体，红瓦阶梯屋顶 / 暖窗 / 门
    px(158, 40, 8, 14, '#121826');
    for (let i = 0; i < 9; i++) px(104 + i * 4, 60 - i * 2, 72 - i * 8, 2, i % 2 ? '#c04b3c' : C.red);
    px(104, 60, 72, 28, C.panel); px(104, 60, 72, 2, C.line);
    px(108, 64, 3, 24, '#202a3c'); px(169, 64, 3, 24, '#202a3c');
    px(112, 66, 18, 13, lit ? C.amberHi : '#101623');
    px(120, 66, 2, 13, C.panel); px(112, 72, 18, 2, C.panel);
    px(146, 72, 16, 16, C.dark); px(158, 80, 2, 2, C.amber);
    if (lit) {
      const g = 1 + Math.min(5, Math.floor((f - 18) / 5));
      for (let i = 1; i <= g; i++) {
        px(112 - i * 3, 66 - i * 2, 18 + i * 6, 2, 'rgba(246,205,147,.14)');
        px(112 - i * 3, 79 + i * 2, 18 + i * 6, 2, 'rgba(246,205,147,.10)');
      }
      px(108, 79, 26, 2, C.warm); px(102, 88, 78, 3, C.warm);
      if (act >= 2) {
        for (let i = 0; i < 9; i++) px(110 + i * 4, 80 + i, 3, 7, 'rgba(246,205,147,.10)');
        for (let i = 0; i < 4; i++) px(114 + i * 5, 20 + (f % 3), 2, 40, 'rgba(246,205,147,.07)');
      }
    } else {
      px(116, 70, 3, 3, '#1d2940');
    }

    // 唱片机：大像素唱碟 + 摆动的唱针
    px(18, 76, 44, 12, C.panel); px(18, 76, 44, 2, C.line);
    const r = 7, cx = 36, cy = 68;
    for (let dy = -r; dy <= r; dy++) {
      const w = Math.floor(Math.sqrt(Math.max(0, r * r - dy * dy)));
      px(cx - w, cy + dy, w * 2, 1, C.dark);
    }
    const spin = lit ? Math.floor(f / 2) % 4 : 0;
    px(cx - 2 + spin, cy - 2, 4, 4, C.amber);
    px(cx - 1, cy - 1, 2, 2, C.amberHi);
    px(52 + (lit ? spin % 2 : 0), 58, 2, 14, C.dim);
    px(54, 58, 12, 2, C.dim);
    if (lit) {
      for (let i = 0; i < 4; i++) {
        const yy = 56 - ((f * 1.3 + i * 13) % 40);
        if (yy > -OY) note(40 + Math.sin((f + i * 9) / 6) * 7, yy, i % 2 ? C.amberHi : C.greenHi);
      }
    }

    // 屋外挥手的小人
    if (act >= 1) hero(76, GROUND, f % 4 < 2 ? 3 : 4, C.blue, 1.6);

    // 萤火 / 星雨（幕 3 爆发）
    const count = act >= 2 ? 18 : 7;
    for (let i = 0; i < count; i++) {
      const yy = 84 - ((f * (act >= 2 ? 1.1 : .7) + i * 19) % 70);
      const xx = -OX + ((i * 23 + 30 + Math.sin((f + i * 7) / 7) * 6) % VW);
      if (yy > -OY + 4) {
        if (i % 3 === 0) spark(xx, yy, C.amberHi, 1);
        else if (i % 2 === 0) note(xx, yy, C.amber);
        else px(xx, yy, 2, 2, C.greenHi);
      }
    }
    if (act >= 2) {
      const colors = [C.greenHi, C.amberHi, C.white, C.green, C.amber];
      fireworks(f, 152, 30, colors, 4);
    }
    if (act === 3) {
      for (let i = 0; i < 16; i++) {
        const x = -OX + rnd(i + 51) * VW;
        const y = 10 + ((f * .6 + i * 9) % 74);
        px(x, y, 1, 1, i % 2 ? C.greenHi : C.amberHi);
      }
      veil(.16);
    }
  }

  /* ---------- 8-bit 芯片音效 ---------- */
  let actx = null;
  function chip(notes, type) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      actx = actx || new AC();
      if (actx.state === 'suspended') actx.resume();
      const t0 = actx.currentTime + .02;
      notes.forEach(([freq, at, dur, vol]) => {
        const osc = actx.createOscillator(), g = actx.createGain();
        osc.type = type || 'square';
        osc.frequency.setValueAtTime(freq, t0 + at);
        g.gain.setValueAtTime(.0001, t0 + at);
        g.gain.linearRampToValueAtTime(vol || .05, t0 + at + .008);
        g.gain.exponentialRampToValueAtTime(.0001, t0 + at + dur);
        osc.connect(g); g.connect(actx.destination);
        osc.start(t0 + at); osc.stop(t0 + at + dur + .02);
      });
    } catch { /* 静音环境不影响彩蛋 */ }
  }
  const SFX = {
    ok: () => chip([[523.25, 0, .12, .05], [659.25, .10, .12, .05], [783.99, .20, .14, .05], [1046.5, .32, .34, .06]]),
    no: () => chip([[196, 0, .10, .045], [146.83, .11, .16, .045]]),
    tap: () => chip([[880, 0, .05, .028]]),
    act: (a) => {
      if (a === 1) chip([[392, 0, .16, .035], [523.25, .14, .2, .035]], 'triangle');
      if (a === 2) chip([[523.25, 0, .12, .05], [659.25, .10, .12, .05], [880, .22, .3, .055], [1174.7, .34, .4, .04]]);
      if (a === 3) chip([[784, 0, .3, .035], [1046.5, .16, .5, .04]], 'triangle');
    },
  };

  /* ---------- 幕间字幕 ---------- */
  const CAPTIONS = {
    first: [
      ['信号来自很远的地方', '……有人先替你把灯打开了'],
      ['一扇门，正在被拼起来', '一格、一格，全是像素'],
      ['音符先到了', '然后是礼花，然后是整个世界'],
      ['初次见面，这里是闻曲', '从今天起，这里会记得你听过的每一首歌'],
    ],
    return: [
      ['这间屋子，一直没关灯', '不对 —— 是刚刚才亮的'],
      ['唱针落回原来的那一圈', '歌单、口味，都还在原处'],
      ['有人从窗口朝你挥手', '好久不见，位置还留着'],
      ['欢迎回来，位置还留着', '歌单、口味、还有那句没说完的话，都在原处'],
    ],
  };

  /* ---------- 状态 ---------- */
  let current = null, prefix = '', composing = false, validating = false;
  let unlocked = false, raf = 0, animStart = 0, eggVisible = false, lastAt = 0;
  let currentAct = -1, tapCount = 0, idleFrame = 0, lastTs = 0;

  function modal() { return $('egg-modal'); }
  function input() { return $('egg-input'); }
  function actOf(f) { return f < ACTS[1] ? 0 : f < ACTS[2] ? 1 : f < ACTS[3] ? 2 : 3; }

  function renderCells(value) {
    const chars = Array.from(String(value || ''));
    $('egg-cells').querySelectorAll('i').forEach((cell, i) => {
      cell.textContent = chars[i] || '';
      cell.classList.toggle('filled', !!chars[i]);
      cell.classList.toggle('next', !chars[i] && i === chars.length);
    });
  }
  function setStatus(text, mode) {
    const st = $('egg-status');
    st.textContent = text || '';
    st.dataset.mode = mode || '';
  }
  function setTrack(act) {
    $('egg-track').querySelectorAll('i').forEach((b, i) => {
      b.classList.toggle('on', i <= act);
      b.classList.toggle('cur', i === act);
    });
  }
  function setCaption(act) {
    const cap = $('egg-caption');
    const pair = (CAPTIONS[current && current.kind] || CAPTIONS.first)[act] || CAPTIONS.first[act];
    $('egg-scene-title').textContent = pair[0];
    $('egg-scene-line').textContent = pair[1];
    cap.classList.remove('show', 'typing');
    void cap.offsetWidth;
    cap.classList.add('show', 'typing');
  }
  function flash() {
    const el = $('egg-flash');
    el.classList.remove('on'); void el.offsetWidth; el.classList.add('on');
  }

  /* ---------- 帧循环 ---------- */
  function drawFrame(ts) {
    if (!ctx || !eggVisible) { raf = 0; return; }
    let f;
    if (unlocked) {
      f = Math.min(TOTAL, Math.max(0, Math.floor((ts - animStart) / (1000 / FPS))));
    } else {
      if (!lastTs) lastTs = ts;
      if (ts - lastTs > 1000 / 8) { idleFrame = (idleFrame + 1) % IDLE_END; lastTs = ts; }
      f = idleFrame;
    }
    const act = actOf(f);
    shakeX = (unlocked && f >= 42 && f <= 47) ? ((f % 3) - 1) * 2 : 0;
    shakeY = (unlocked && f >= 44 && f <= 46) ? ((f % 2) ? 1 : -1) : 0;
    ctx.clearRect(0, 0, CW, CH);
    (current && current.kind === 'return' ? drawReturn : drawFirst)(f);
    shakeX = shakeY = 0;

    if (unlocked && act !== currentAct) {
      currentAct = act;
      setTrack(act);
      setCaption(act);
      if (act === 2) flash();
      SFX.act(act);
    }
    if (unlocked && f >= TOTAL) {
      raf = 0;
      modal().dataset.phase = 'finale';
      $('egg-end-title').textContent = (current && current.sceneTitle) || '欢迎来到闻曲';
      $('egg-end').hidden = false;
      $('egg-caption').classList.remove('show');
      return;
    }
    raf = requestAnimationFrame(drawFrame);
  }
  function startAnimation() {
    if (raf) cancelAnimationFrame(raf);
    currentAct = -1;
    animStart = performance.now();
    lastTs = 0; idleFrame = 0;
    raf = requestAnimationFrame(drawFrame);
  }

  /* ---------- 开 / 关 ---------- */
  function open(p) {
    if (!p || !modal()) return;
    if (eggVisible && Number(p.at || 0) === lastAt) return;
    current = p; lastAt = Number(p.at || 0); eggVisible = true;
    unlocked = false; validating = false; composing = false;
    prefix = Array.from(p.reveal || '').join('');
    tapCount = 0; currentAct = -1; idleFrame = 0; lastTs = 0;

    const m = modal();
    m.hidden = false;
    m.setAttribute('aria-hidden', 'false');
    m.dataset.kind = p.kind || 'first';
    m.dataset.phase = 'gate';
    $('egg-badge').textContent = p.badge || 'EASTER EGG';
    $('egg-kicker').textContent = p.kind === 'return' ? 'HIDDEN TRACK 02 / WELCOME BACK' : 'HIDDEN TRACK 01 / FIRST MEET';
    $('egg-title').textContent = p.title || '彩蛋';
    $('egg-riddle').textContent = p.riddle || '';
    $('egg-subtitle').textContent = p.subtitle || '';
    $('egg-scene-title').textContent = '';
    $('egg-scene-line').textContent = '';
    $('egg-end-title').textContent = p.sceneTitle || '';
    $('egg-end').hidden = true;
    $('egg-caption').classList.remove('show', 'typing');
    $('egg-flash').classList.remove('on');
    $('egg-gate-box').classList.remove('shake');
    setTrack(-1);
    input().value = '';
    input().disabled = false;
    renderCells('');
    setStatus(prefix ? `前 ${Array.from(prefix).length} 个字：${prefix}　·　四个字都要自己输完` : '输入四个字，按回车', prefix ? 'hint' : '');

    if (!ctx) {
      canvas = $('egg-canvas');
      if (canvas && canvas.getContext) ctx = canvas.getContext('2d');
    }
    resize();
    if (ctx) startAnimation();
    setTimeout(() => { if (eggVisible && !unlocked) input().focus({ preventScroll: true }); }, 140);
  }

  function close() {
    eggVisible = false;
    unlocked = false; validating = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    const m = modal();
    if (!m) return;
    m.hidden = true;
    m.setAttribute('aria-hidden', 'true');
    m.dataset.phase = 'gate';
    $('egg-flash').classList.remove('on');
    $('egg-end').hidden = true;
    $('egg-caption').classList.remove('show', 'typing');
    current = null;
  }

  /* ---------- 暗号输入 ---------- */
  const HAN = '\\u3400-\\u9fff\\uf900-\\ufaff';
  const HAN_RE = new RegExp(`^[${HAN}]{4}$`);
  const VALID_RE = new RegExp(`[${HAN}A-Za-z0-9]`);
  function normalize(v) {
    return Array.from(String(v || '').replace(/\s+/g, ''))
      .filter(ch => VALID_RE.test(ch))
      .slice(0, 4).join('');
  }
  function revealPhase() {
    unlocked = true;
    currentAct = -1;
    modal().dataset.phase = 'cinema';
    input().disabled = true;
    setStatus('✓ 暗号正确，演出开始', 'ok');
    startAnimation();
  }

  async function submit(value) {
    if (validating || unlocked || !current) return;
    const chars = normalize(value);
    if (Array.from(chars).length !== 4) { setStatus('还差 ' + (4 - Array.from(chars).length) + ' 个字', 'error'); return; }
    validating = true;
    input().disabled = true;
    setStatus('正在核对……', '');
    let r;
    try { r = await post('/api/login/egg/check', { phrase: chars }); }
    catch { r = { ok: false, message: '本机服务没有响应，再试一次' }; }
    validating = false;
    if (!r || !r.ok) {
      if (!unlocked) input().disabled = false;
      SFX.no();
      prefix = Array.from((r && r.reveal) || prefix || '').join('');
      const msg = (r && r.message) || '愿望不太对，再想想';
      setStatus(prefix ? `${msg}　·　已提示：${prefix}` : msg, r && r.attempts >= 2 ? 'hint' : 'error');
      const box = $('egg-gate-box');
      box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake');
      input().value = '';
      renderCells('');
      setTimeout(() => { if (eggVisible && !unlocked) input().focus({ preventScroll: true }); }, 60);
      return;
    }
    SFX.ok();
    revealPhase();
  }

  async function skip() {
    try { await post('/api/login/egg/skip', {}); } catch { /* 忽略 */ }
    close();
  }
  async function replay(kind) {
    try { await post('/api/login/egg/replay', { kind }); } catch { /* 忽略 */ }
    lastAt = 0;
    poll(true);
  }
  async function poll(force) {
    if (!force && eggVisible) return;
    let st;
    try { st = await get('/api/login/egg/status'); } catch { return; }
    if (st && st.pending) open(st.pending);
  }

  /* ---------- 交互绑定 ---------- */
  function onInput() {
    if (composing || validating || unlocked || !eggVisible) return;
    const value = normalize(input().value);
    // 只在非输入法组合期回写，避免打断中文候选与上屏
    if (input().value !== value) input().value = value;
    renderCells(value);
    if (HAN_RE.test(value)) submit(value);
  }
  function bind() {
    if (!modal()) return;
    const inp = input();
    inp.addEventListener('compositionstart', () => { composing = true; });
    inp.addEventListener('compositionend', () => { composing = false; onInput(); });
    inp.addEventListener('input', onInput);
    inp.addEventListener('keydown', (e) => {
      // 输入框会截断冒泡，Escape 必须在这里就地处理，否则演出时按 ESC 无反应
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); skip(); return; }
      e.stopPropagation();
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        if (unlocked) close(); else submit(inp.value);
      }
    });
    $('egg-eye').addEventListener('click', () => {
      if (unlocked || !current) return;
      SFX.tap(); tapCount++;
      const eye = $('egg-eye');
      eye.classList.remove('blink'); void eye.offsetWidth; eye.classList.add('blink');
      const lines = ['它好像看了你一眼', '再点一下', current.hint || current.riddle || ''];
      $('egg-riddle').textContent = lines[Math.min(tapCount, lines.length - 1)];
      inp.focus({ preventScroll: true });
    });
    $('egg-cells').addEventListener('click', () => { if (!unlocked) inp.focus({ preventScroll: true }); });
    $('egg-hint').addEventListener('click', () => {
      if (!current) return;
      SFX.tap();
      setStatus(prefix ? `已提示：${prefix}　·　${current.hint || ''}` : (current.hint || current.riddle || ''), 'hint');
      inp.focus({ preventScroll: true });
    });
    $('egg-submit').addEventListener('click', () => submit(inp.value));
    $('egg-skip').addEventListener('click', skip);
    $('egg-close').addEventListener('click', close);
    $('egg-replay').addEventListener('click', () => replay(current ? current.kind : 'first'));
    modal().addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); skip(); }
    });
    window.addEventListener('resize', () => {
      if (!eggVisible || !ctx) return;
      resize();
      if (unlocked && !raf) {   // 落版后 resize 重绘最后一帧
        ctx.clearRect(0, 0, CW, CH);
        (current && current.kind === 'return' ? drawReturn : drawFirst)(TOTAL);
      }
    });
    setTimeout(() => poll(), 700);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();

  window.Egg = {
    poll, open, close, replay, skip,
    debug: () => ({ visible: eggVisible, unlocked, validating, phase: modal() ? modal().dataset.phase : '', act: currentAct, kind: current && current.kind, W: CW, H: CH }),
  };
})();
