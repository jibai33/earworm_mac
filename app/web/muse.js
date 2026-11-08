/* ═══════════════════════════════════════════════════════════════
   闻曲 · 角落乐手（Pixel Muse）
   ---------------------------------------------------------------
   首页左下角的小角色：跟着正在播放的音乐打拍子、弹乐器、跳舞。

   · 精灵是纯矩形拼的 24×32 像素图（viewBox 单位 = 1 格 = 4px），
     不用图片，跟着皮肤一起变色，缩放也不会糊
   · 节拍来自 app.js 已经建好的 Web Audio analyser（低频能量做
     自适应阈值起音检测），没有分析器时退化成固定 480ms 一拍
   · 乐器由曲名哈希决定（同一首歌永远是同一件乐器），点一下换一件
   ═══════════════════════════════════════════════════════════════ */
(() => {
  'use strict';

  const audio = document.getElementById('audio');
  const host = document.getElementById('px-muse');
  if (!audio || !host) return;

  /* ---------------- 调色板（与 pixel.css 同一套） ---------------- */
  const C = {
    k: '#241a24',  // 描边
    s: '#ffd9bd',  // 皮肤
    s2: '#f0bd9a', // 皮肤暗部
    h: '#7a4b2f',  // 头发
    h2: '#5d3722', // 头发暗部
    h3: '#9c653f', // 头发高光
    e: '#33283a',  // 眼睛
    l: '#ffffff',  // 眼里高光
    m: '#c05a58',  // 嘴
    b: '#f3a3a0',  // 腮红
    c: '#4d6b85',  // 上衣（蓝灰）
    c2: '#3a5268', // 上衣暗部
    p: '#2b3a4d',  // 裤子
    sh: '#1c2530', // 鞋
    w: '#c98a4b',  // 木器
    w2: '#e2bb8a',
    W: '#8a5626',
    n: '#fdf6e6',  // 琴弦 / 白键
    g: '#5b6675',  // 金属
    d: '#12161d',  // 琴箱黑
  };

  /* ---------------- 精灵：一堆 [色, x, y, w, h] ----------------
     每层先画「放大 1 格的同形黑块」，再盖本色，等于自动描边；
     小尺寸下有没有这圈黑边，辨识度差很多。 */
  /* 圆脑袋小兽：头占大半个身子才是「可爱」的关键 */
  /* 圆头小人：头几乎和身子一样高，眼睛大、嘴小、带一根呆毛 */
  const HEAD = [
    // 呆毛
    [C.h, 15, 2, 2, 1], [C.h, 16, 3, 1, 2],
    // 头发外轮廓
    [C.h, 11, 4, 10, 1],
    [C.h, 9, 5, 14, 1],
    [C.h, 8, 6, 16, 5],
    [C.h, 8, 11, 2, 8], [C.h, 22, 11, 2, 8],
    [C.h3, 11, 4, 5, 1],
    // 脸
    [C.s, 10, 10, 12, 10],
    [C.s, 11, 20, 10, 1],
    [C.s, 13, 21, 6, 1],
    // 刘海
    [C.h, 10, 10, 4, 2], [C.h, 18, 10, 4, 2], [C.h, 14, 10, 4, 1],
    // 眼睛
    [C.e, 11, 14, 3, 4], [C.e, 18, 14, 3, 4],
    [C.l, 11, 14, 1, 1], [C.l, 18, 14, 1, 1],
    [C.l, 12, 16, 1, 1], [C.l, 19, 16, 1, 1],
    // 嘴 / 腮红
    [C.m, 15, 19, 2, 1],
    [C.b, 9, 17, 2, 1], [C.b, 21, 17, 2, 1],
  ];

  const TORSO = [
    [C.s, 14, 21, 4, 2],   // 脖子
    [C.n, 11, 22, 10, 1],  // 衣领
    [C.c, 11, 23, 10, 5],  // 卫衣
    [C.c2, 19, 23, 2, 5],
    [C.c2, 13, 26, 6, 1],  // 口袋
    [C.p, 12, 28, 8, 4],   // 裤子
  ];

  const LEG_L = [[C.p, 12, 30, 3, 3], [C.sh, 11, 32, 4, 2]];
  const LEG_R = [[C.p, 17, 30, 3, 3], [C.sh, 17, 32, 4, 2]];

  // 手臂：短胖
  const ARM_L = [[C.c, 8, 23, 3, 4], [C.s, 8, 27, 3, 2]];
  const ARM_R = [[C.c, 21, 23, 3, 4], [C.s, 21, 27, 3, 2]];

  /* 琵琶：抱在肚子前，梨形琴身 */
  const PIPA = [
    [C.w, 14, 24, 4, 1],
    [C.w, 12, 25, 8, 1],
    [C.w, 12, 26, 8, 5],
    [C.w, 13, 31, 6, 1],
    [C.w, 14, 32, 4, 1],
    [C.w2, 13, 26, 6, 4],
    [C.W, 16, 20, 2, 5],
    [C.w, 15, 18, 4, 2],
    [C.n, 14, 27, 1, 5], [C.n, 16, 27, 1, 5],
    [C.k, 15, 28, 2, 2],
  ];

  /* 钢琴：横在肚子前的小键盘 */
  const PIANO = [
    [C.d, 7, 25, 18, 2],
    [C.n, 7, 27, 18, 4],
    [C.d, 9, 27, 1, 2], [C.d, 11, 27, 1, 2], [C.d, 13, 27, 1, 2],
    [C.d, 16, 27, 1, 2], [C.d, 18, 27, 1, 2], [C.d, 20, 27, 1, 2],
    [C.d, 22, 27, 1, 2],
  ];

  /* 小提琴：抱在胸前，琴颈指向右，弓竖着拉 */
  const VIOLIN = [
    [C.w, 13, 21, 4, 1],
    [C.w, 11, 22, 8, 6],
    [C.w, 13, 28, 4, 1],
    [C.w2, 13, 23, 4, 3],
    [C.k, 12, 24, 1, 1], [C.k, 17, 24, 1, 1],
    [C.W, 19, 23, 5, 1],
    [C.W, 24, 22, 2, 1],
  ];
  const BOW = [
    [C.n, 19, 24, 1, 7],
    [C.g, 19, 23, 1, 1],
  ];

  // 一层精灵 = 先栅格化到 24×32 网格，再把「外侧轮廓」描一圈黑，
  // 这样相邻色块之间不会出现多余的边框，只有整体剪影有一圈。
  function rasterToSvg(cells) {
    const rows = new Map();
    for (const [key, col] of cells) {
      const [x, y] = key.split(',').map(Number);
      if (!rows.has(y)) rows.set(y, new Map());
      rows.get(y).set(x, col);
    }
    let out = '';
    for (const [y, xs] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
      const list = [...xs.keys()].sort((a, b) => a - b);
      let start = list[0], prev = list[0], col = xs.get(start);
      for (let i = 1; i <= list.length; i++) {
        const x = list[i];
        if (x !== undefined && x === prev + 1 && xs.get(x) === col) { prev = x; continue; }
        out += `<rect x="${start}" y="${y}" width="${prev - start + 1}" height="1" fill="${col}"/>`;
        if (x !== undefined) { start = x; prev = x; col = xs.get(x); }
      }
    }
    return out;
  }

  const layer = list => {
    const cells = new Map();
    for (const [fill, x, y, w, h] of list) {
      for (let i = 0; i < w; i++) {
        for (let j = 0; j < h; j++) cells.set(`${x + i},${y + j}`, fill);
      }
    }
    const outline = new Map();
    for (const key of cells.keys()) {
      const [x, y] = key.split(',').map(Number);
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const k = `${x + dx},${y + dy}`;
        if (!cells.has(k)) outline.set(k, C.k);
      }
    }
    return rasterToSvg(new Map([...outline, ...cells]));
  };

  const svg = `
<svg class="muse-svg" viewBox="0 0 32 40" width="96" height="120"
     shape-rendering="crispEdges" aria-hidden="true">
  <g class="muse-root">
    <rect class="muse-shadow" x="8" y="36" width="16" height="2" fill="#000" opacity=".45"/>
    <g class="muse-leg muse-leg-l">${layer(LEG_L)}</g>
    <g class="muse-leg muse-leg-r">${layer(LEG_R)}</g>
    <g class="muse-torso">${layer(TORSO)}</g>
    <g class="muse-inst" data-p="pipa">${layer(PIPA)}</g>
    <g class="muse-inst" data-p="piano">${layer(PIANO)}</g>
    <g class="muse-inst" data-p="violin">${layer(VIOLIN)}</g>
    <g class="muse-arm muse-arm-l">${layer(ARM_L)}</g>
    <g class="muse-arm muse-arm-r">${layer(ARM_R)}</g>
    <g class="muse-bow" data-p="violin">${layer(BOW)}</g>
    <g class="muse-head">${layer(HEAD)}</g>
  </g>
</svg>`;

  host.innerHTML = svg +
    '<span class="muse-tag"><b id="muse-tag-name">琵琶</b> · 点我换乐器</span>';

  /* ---------------- 乐器 ---------------- */
  const INSTRUMENTS = [
    { id: 'pipa', name: '琵琶' },
    { id: 'piano', name: '钢琴' },
    { id: 'violin', name: '小提琴' },
  ];
  let instIndex = 0;

  function hashOf(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
    return h >>> 0;
  }

  function setInstrument(i, silent) {
    instIndex = ((i % INSTRUMENTS.length) + INSTRUMENTS.length) % INSTRUMENTS.length;
    const inst = INSTRUMENTS[instIndex];
    host.dataset.inst = inst.id;
    const tag = host.querySelector('#muse-tag-name');
    if (tag) tag.textContent = inst.name;
    if (!silent) burst(host.querySelector('.muse-root'), 2);
  }

  /* 同一首歌固定同一件乐器：按曲名哈希取，点一下再加一 */
  let trackName = '';
  function syncTrack(name, silent) {
    const n = (name || '').trim();
    if (n === trackName) return;
    trackName = n;
    if (!n) return;
    setInstrument(hashOf(n), silent);
  }

  host.addEventListener('click', () => setInstrument(instIndex + 1));

  /* ---------------- 节拍 ---------------- */
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let pose = 0;
  let lastBeat = 0;
  let lastScan = 0;
  let bassAvg = 0.05;
  let beatTimes = [];
  let notes = 0;

  const isPlaying = () => !audio.paused && !audio.ended && audio.readyState > 2;

  function bassEnergy() {
    if (typeof analyser === 'undefined' || !analyser || !freqData) return null;
    try {
      analyser.getByteFrequencyData(freqData);
    } catch { return null; }
    let sum = 0;
    for (let i = 0; i < 5; i++) sum += freqData[i];
    return sum / 5 / 255;
  }

  function onBeat(now) {
    pose ^= 1;
    host.dataset.pose = String(pose);
    host.dataset.beat = '1';
    clearTimeout(onBeat._t);
    onBeat._t = setTimeout(() => { host.dataset.beat = '0'; }, 110);

    beatTimes.push(now);
    if (beatTimes.length > 8) beatTimes.shift();

    if (notes < 6 && pose === 1) burst(host.querySelector('.muse-root'), 1);
  }

  /* ------------------------------------------------------------------
     起音检测：低频能量相对自身滑动均值突然抬头就算一拍。
     这比按固定 BPM 猜稳，慢歌快歌都能跟上；长时间没检测到就
     退化成 480ms 固定拍子，避免画面僵住。
     ------------------------------------------------------------------ */
  function scan(now) {
    if (now - lastScan < 32) return;
    lastScan = now;

    if (!isPlaying()) {
      host.dataset.playing = '0';
      return;
    }
    host.dataset.playing = '1';

    const bass = bassEnergy();
    if (bass !== null) {
      const ratio = bass / (bassAvg + 0.035);
      if (ratio > 1.32 && bass > 0.16 && now - lastBeat > 250) {
        bassAvg = bassAvg * 0.72 + bass * 0.28;
        lastBeat = now;
        onBeat(now);
        return;
      }
      bassAvg = bassAvg * 0.94 + bass * 0.06;
      if (now - lastBeat < 2000) return;
    }

    if (now - lastBeat > 2000) {
      lastBeat = now;
      onBeat(now);
    }
  }

  /* 一拍弹出的小音符 */
  const NOTE_GLYPHS = ['♪', '♩', '♫', '♬'];
  function burst(root, count) {
    if (reduce || !root) return;
    for (let i = 0; i < count; i++) {
      notes++;
      const n = document.createElement('i');
      n.className = 'muse-note';
      n.textContent = NOTE_GLYPHS[(Math.random() * NOTE_GLYPHS.length) | 0];
      n.style.left = (18 + Math.random() * 46) + 'px';
      n.style.animationDelay = (i * 90) + 'ms';
      host.appendChild(n);
      setTimeout(() => { n.remove(); notes--; }, 1500);
    }
  }

  /* ---------------- 主循环 ---------------- */
  function tick(now) {
    requestAnimationFrame(tick);
    // 只在发现页出现
    const page = document.getElementById('page-discover');
    const onHome = page && !page.hidden;
    host.classList.toggle('is-away', !onHome);
    if (!onHome) return;
    scan(now);
  }

  /* 曲名变化 → 换乐器（同一首固定同一件） */
  const nameEl = document.getElementById('mini-name');
  if (nameEl) {
    new MutationObserver(() => syncTrack(nameEl.textContent, true))
      .observe(nameEl, { childList: true, characterData: true, subtree: true });
    syncTrack(nameEl.textContent, true);
  }

  setInstrument(instIndex, true);
  host.dataset.pose = '0';
  host.dataset.playing = '0';
  requestAnimationFrame(tick);
})();
