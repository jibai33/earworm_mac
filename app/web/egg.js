/* ====================================================================
   闻曲 · 登录彩蛋（像素风）
   ------------------------------------------------------------------
   流程：登录成功 → 弹出暗号门 → 点像素眼睛 / 直接输入四字暗号
        → 服务端校验 → 8-bit 逐帧动画 + 芯片音效 → 继续听歌
   两套场景：首次登录「初次相遇」／退出后重登「久别重逢」
   画布逻辑分辨率 192×108，只用 fillRect 画整块像素，CSS 放大不插值。
   ==================================================================== */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const C = {
    bg: '#08090c', sky: '#0e1014', deep: '#151920', panel: '#1d232c',
    line: '#2b323d', txt: '#eae4d6', dim: '#98a0a8',
    amber: '#e6b06a', amberHi: '#f6cd93', red: '#d1483a',
    green: '#8fb8ae', blue: '#5f83b0', purple: '#8b6fae',
    skin: '#f0c9a0', hair: '#3a2b22', dark: '#111319', warm: '#6f5432',
  };
  const W = 192, H = 108, GROUND = 88;
  const FPS = 12, TOTAL = 54;

  function eggApi(p, opts) {
    if (typeof window.api === 'function') return window.api(p, opts);
    return fetch(p, opts).then(r => r.json());
  }
  function post(p, body) {
    return eggApi(p, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
  }

  /* ---------- 像素画笔 ---------- */
  let ctx = null;
  function px(x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  }
  function rnd(seed) { const v = Math.sin(seed * 12.9898) * 43758.5453; return v - Math.floor(v); }
  const STARS = Array.from({ length: 30 }, (_, i) => ({
    x: Math.floor(rnd(i + 3) * W), y: Math.floor(rnd(i + 71) * 58), tier: i % 3,
  }));
  function note(x, y, c) {
    px(x, y + 2, 3, 2, c); px(x + 3, y, 1, 4, c); px(x + 4, y, 2, 1, c);
  }
  function hero(x, groundY, pose, coat) {
    const y = groundY - 13;
    px(x + 1, y, 6, 2, C.hair);                       // 头发
    px(x + 1, y + 2, 6, 4, C.skin);                   // 脸
    px(x + 2, y + 3, 1, 1, C.dark); px(x + 5, y + 3, 1, 1, C.dark);
    px(x + 3, y + 5, 2, 1, C.red);                    // 嘴
    px(x + 1, y + 6, 6, 5, coat);                     // 身体
    px(x + 3, y + 6, 2, 2, C.amber);                  // 领口
    if (pose === 2) { px(x - 1, y + 3, 2, 2, C.skin); px(x + 7, y + 3, 2, 2, C.skin); }
    else if (pose === 3) { px(x - 1, y + 7, 2, 2, C.skin); px(x + 7, y + 2, 2, 3, C.skin); }
    else if (pose === 4) { px(x - 1, y + 7, 2, 2, C.skin); px(x + 7, y + 4, 2, 3, C.skin); }
    else if (pose === 1) { px(x - 1, y + 6, 2, 2, C.skin); px(x + 7, y + 7, 2, 2, C.skin); }
    else { px(x - 1, y + 7, 2, 2, C.skin); px(x + 7, y + 7, 2, 2, C.skin); }
    px(x + 1, y + 11, 2, 2, C.dark); px(x + 5, y + 11, 2, 2, C.dark);
  }
  function sky(f) {
    px(0, 0, W, H, C.bg);
    STARS.forEach((s, i) => {
      if ((f + i * 2) % 8 < (s.tier === 0 ? 7 : s.tier === 1 ? 5 : 3)) {
        px(s.x, s.y, 1, 1, s.tier === 0 ? C.amberHi : C.dim);
      }
    });
  }
  function ground(warm) {
    for (let i = 0; i < 10; i++) {
      const h = 4 + Math.floor(i / 3) * 3;
      px(i * 20, GROUND - h, 20, h, C.deep);
    }
    px(0, GROUND, W, H - GROUND, C.sky);
    px(0, GROUND, W, 1, warm ? C.amber : C.line);
    for (let i = 0; i < 22; i++) {
      px((i * 11 + 3) % W, 94 + (i % 3) * 4, 4, 1, warm ? C.warm : C.panel);
    }
  }

  /* ---------- 场景 01 · 初次相遇：传送门 / 出走 / 礼花 ---------- */
  function drawFirst(f) {
    sky(f); ground(f >= 34);
    const open = Math.min(30, Math.max(0, (f - 1) * 2.2));
    if (open > 1) {
      const l = 80 - open / 2, r = 80 + open / 2;
      px(l, 45, 2, 43, C.amber); px(r - 2, 45, 2, 43, C.amber);
      px(l, 45, open, 2, C.amberHi); px(l, 86, open, 2, C.amber);
      for (let y = 48; y < 85; y += 4) {
        for (let x = l + 2; x < r - 2; x += 3) {
          if ((x + y + f) % 5 < 3) px(x, y, 2, 2, (x + y + f) % 7 < 3 ? C.purple : C.blue);
        }
      }
      px(l - 2, 43, 4, 2, C.amberHi); px(r - 2, 43, 4, 2, C.amberHi);
    }
    if (f >= 14) {
      const t = Math.min(1, (f - 14) / 17);
      const hx = Math.round(80 - t * 38);
      hero(hx, GROUND, f >= 33 ? 2 : (f % 4 < 2 ? 0 : 1), C.green);
    }
    if (f >= 18) {
      const rise = (f - 18) * 1.15;
      note(30 + Math.sin(f / 5) * 3, 84 - rise, C.amber);
      note(142 - Math.sin(f / 4) * 3, 84 - rise * .8, C.amberHi);
      note(112 + Math.sin(f / 6) * 2, 84 - rise * .6, C.green);
    }
    if (f >= 30) {
      const d = (f - 30) * 2.6;
      const colors = [C.amber, C.red, C.green, C.blue, C.amberHi, C.purple];
      for (let i = 0; i < 16; i++) {
        const a = i * Math.PI * 2 / 16;
        const nx = 96 + Math.cos(a) * d, ny = 38 + Math.sin(a) * d * .7;
        if (nx > 1 && nx < W - 2 && ny > 1 && ny < GROUND - 2) px(nx, ny, 2, 2, colors[i % colors.length]);
      }
    }
  }

  /* ---------- 场景 02 · 久别重逢：亮灯的屋 / 唱片 / 挥手 ---------- */
  function drawReturn(f) {
    sky(f);
    // 像素月亮
    const inset = [3, 2, 1, 0, 0, 0, 1, 2];
    for (let r = 0; r < 8; r++) px(24 + inset[r], 12 + r, 8 - inset[r] * 2, 1, C.amberHi);
    px(27, 15, 2, 2, C.amber); px(20, 22, 2, 2, C.bg);
    const lit = f >= 20;
    ground(lit);
    // 屋顶（阶梯三角）
    for (let i = 0; i < 7; i++) px(112 + i * 5, 62 - i * 2, 36 - i * 10, 2, C.red);
    px(160, 48, 6, 12, C.deep);
    px(114, 62, 56, 26, C.panel);
    px(114, 62, 56, 1, C.line);
    // 窗（灯亮）
    px(120, 67, 12, 10, lit ? C.amberHi : C.deep);
    px(125, 67, 2, 10, C.panel); px(120, 71, 12, 2, C.panel);
    if (lit) { px(118, 77, 16, 2, C.warm); px(116, 88, 52, 3, C.warm); }
    // 门
    px(146, 72, 12, 16, C.dark);
    px(155, 80, 2, 2, C.amber);
    // 唱片机
    px(28, 78, 30, 10, C.panel); px(28, 78, 30, 1, C.line);
    const spin = Math.floor(f / 2) % 4;
    const disc = [[3, 1], [1, 3], [0, 4], [1, 3]][spin];
    px(38 - disc[0], 70 - disc[1], disc[0] * 2 + 2, disc[1] * 2 + 2, C.dark);
    px(38, 74, 2, 2, C.amber);
    px(56 + (spin % 2), 70, 2, 8, C.dim);
    px(58, 70, 8, 2, C.dim);
    // 挥手的小人
    if (f >= 8) hero(78, GROUND, f % 4 < 2 ? 3 : 4, C.blue);
    // 音符 / 萤火
    for (let i = 0; i < 5; i++) {
      const yy = 84 - ((f * .7 + i * 19) % 60);
      const xx = 96 + i * 18 + Math.sin((f + i * 7) / 7) * 4;
      if (yy > 6) {
        if (i % 2 === 0) note(xx, yy, C.amber);
        else px(xx, yy, 2, 2, C.green);
      }
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
        g.gain.linearRampToValueAtTime(vol || .055, t0 + at + .008);
        g.gain.exponentialRampToValueAtTime(.0001, t0 + at + dur);
        osc.connect(g); g.connect(actx.destination);
        osc.start(t0 + at); osc.stop(t0 + at + dur + .02);
      });
    } catch { /* 静音环境不影响彩蛋 */ }
  }
  const SFX = {
    ok: () => chip([[523.25, 0, .12, .05], [659.25, .10, .12, .05], [783.99, .20, .14, .05], [1046.5, .32, .34, .06]]),
    no: () => chip([[196, 0, .10, .045], [146.83, .11, .16, .045]], 'square'),
    tap: () => chip([[880, 0, .05, .028]]),
  };

  /* ---------- 状态 ---------- */
  let current = null, prefix = '', composing = false, validating = false;
  let unlocked = false, raf = 0, animStart = 0, eggVisible = false, lastAt = 0;
  let tapCount = 0;

  function modal() { return $('egg-modal'); }
  function input() { return $('egg-input'); }

  function renderCells(value) {
    const chars = Array.from(String(value || ''));
    const cells = $('egg-cells').querySelectorAll('i');
    cells.forEach((cell, i) => {
      cell.textContent = chars[i] || '';
      cell.classList.toggle('filled', !!chars[i]);
      cell.classList.toggle('fixed', i < Array.from(prefix).length);
    });
  }
  function setStatus(text, mode) {
    const st = $('egg-status');
    st.textContent = text || '';
    st.dataset.mode = mode || '';
  }

  /* 待机时画布循环前 14 帧，解锁后跑完整 54 帧 */
  function drawFrame(ts) {
    const f = Math.min(TOTAL, Math.floor((ts - animStart) / (1000 / FPS)));
    const shown = unlocked ? f : f % 14;
    ctx.clearRect(0, 0, W, H);
    (current && current.kind === 'return' ? drawReturn : drawFirst)(shown);
    if (unlocked && f >= 28) $('egg-scene-copy').classList.add('show');
    if (unlocked && f >= TOTAL) {
      raf = 0;
      $('egg-end').hidden = false;
      return;
    }
    raf = requestAnimationFrame(drawFrame);
  }
  function startAnimation() {
    if (raf) cancelAnimationFrame(raf);
    animStart = performance.now();
    raf = requestAnimationFrame(drawFrame);
  }

  function open(p) {
    if (!p || !modal()) return;
    // 同一枚彩蛋不重复弹
    if (eggVisible && Number(p.at || 0) === lastAt) return;
    current = p; lastAt = Number(p.at || 0); eggVisible = true;
    unlocked = false; validating = false; composing = false; prefix = Array.from(p.reveal || '').join('');
    tapCount = 0;
    modal().hidden = false;
    modal().setAttribute('aria-hidden', 'false');
    modal().dataset.kind = p.kind || 'first';
    $('egg-badge').textContent = p.badge || 'EASTER EGG';
    $('egg-title').textContent = p.title || '彩蛋';
    $('egg-subtitle').textContent = p.subtitle || '';
    $('egg-riddle').textContent = p.riddle || '';
    $('egg-scene-title').textContent = p.sceneTitle || '';
    $('egg-scene-line').textContent = p.sceneLine || '';
    $('egg-scene-copy').classList.remove('show');
    $('egg-idle').classList.remove('gone');
    $('egg-end').hidden = true;
    $('egg-entry').hidden = false;
    input().value = prefix;
    input().disabled = false;
    renderCells(prefix);
    setStatus(prefix ? '前几个字已经替你填好了' : '输入四个字，按回车', prefix ? 'hint' : '');
    if (!ctx) {
      const canvas = $('egg-canvas');
      if (canvas && canvas.getContext) ctx = canvas.getContext('2d');
    }
    if (ctx) startAnimation();
    setTimeout(() => { if (eggVisible) input().focus({ preventScroll: true }); }, 120);
  }

  function close() {
    eggVisible = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    const m = modal();
    if (!m) return;
    m.hidden = true;
    m.setAttribute('aria-hidden', 'true');
    current = null;
  }

  async function submit(value) {
    if (validating || unlocked || !current) return;
    const chars = Array.from(String(value || '').replace(/\s+/g, ''));
    if (chars.length !== 4) { setStatus('还差 ' + (4 - chars.length) + ' 个字', 'error'); return; }
    validating = true;
    setStatus('正在核对……', '');
    let r;
    try { r = await post('/api/login/egg/check', { phrase: chars.join('') }); }
    catch (e) { r = { ok: false, message: '本机服务没有响应' }; }
    validating = false;
    if (!r || !r.ok) {
      SFX.no();
      prefix = Array.from((r && r.reveal) || prefix || '').join('');
      const msg = (r && r.message) || '愿望不太对，再想想';
      setStatus(msg, r && r.attempts >= 2 ? 'hint' : 'error');
      $('egg-entry').classList.remove('shake');
      void $('egg-entry').offsetWidth;
      $('egg-entry').classList.add('shake');
      const keep = prefix;
      setTimeout(() => {
        if (!eggVisible || unlocked) return;
        input().value = keep;
        renderCells(keep);
        input().focus({ preventScroll: true });
      }, 420);
      return;
    }
    unlocked = true;
    prefix = '';
    SFX.ok();
    setStatus('✓ 愿望已收到', 'ok');
    $('egg-idle').classList.add('gone');
    input().disabled = true;
    $('egg-entry').classList.add('accepted');
    $('egg-scene-title').textContent = (r.scene && r.scene.sceneTitle) || current.sceneTitle || '';
    $('egg-scene-line').textContent = (r.scene && r.scene.sceneLine) || current.sceneLine || '';
    startAnimation();
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
    try { st = await eggApi('/api/login/egg/status'); } catch { return; }
    if (st && st.pending) open(st.pending);
  }

  /* ---------- 交互绑定 ---------- */
  function bind() {
    const m = modal();
    if (!m) return;
    const inp = input();
    inp.addEventListener('compositionstart', () => { composing = true; });
    inp.addEventListener('compositionend', () => { composing = false; onInput(); });
    inp.addEventListener('input', onInput);
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        if (unlocked) close(); else submit(inp.value);
      }
    });
    function onInput() {
      if (composing || validating || unlocked) return;
      let chars = Array.from(inp.value.replace(/\s+/g, '')).slice(0, 4);
      const pre = Array.from(prefix);
      if (pre.length && chars.slice(0, pre.length).join('') !== prefix) {
        chars = pre.concat(chars.slice(-(4 - pre.length)));
      }
      const value = chars.join('');
      inp.value = value;
      renderCells(value);
      if (chars.length === 4) submit(value);
    }
    // 像素眼睛：点几下给出更直白的谜面，致敬 Mineradio 的点击揭示
    $('egg-eye').addEventListener('click', () => {
      if (unlocked || !current) return;
      SFX.tap();
      tapCount++;
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
      setStatus(prefix ? '前几个字：' + prefix + '　·　' + (current.hint || '') : (current.hint || current.riddle || ''), 'hint');
      inp.focus({ preventScroll: true });
    });
    $('egg-skip').addEventListener('click', skip);
    $('egg-close').addEventListener('click', close);
    $('egg-replay').addEventListener('click', () => replay(current ? current.kind : 'first'));
    m.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); skip(); }
    });
    // 上次没拆完的彩蛋，开机后补放一次
    setTimeout(() => poll(), 700);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();

  window.Egg = { poll, open, close, replay, skip };
})();
