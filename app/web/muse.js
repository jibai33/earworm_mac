/* ═══════════════════════════════════════════════════════════════
   闻曲 · 角落乐手（Pixel Muse）
   ---------------------------------------------------------------
   首页左下角的小角色：跟着正在播放的音乐打拍子、弹乐器、跳舞。

   · 精灵是纯矩形拼的 64×80 像素图（viewBox 单位 = 1 格 = 2px），
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
    k:  '#0d1119',  // 描边
    s:  '#f6cfab',  // 皮肤
    s2: '#dcab86',  // 皮肤暗部
    s3: '#bd8a69',  // 皮肤最暗（下颌、眼睑）
    h:  '#6d4c31',  // 头发
    h2: '#4a3120',  // 头发暗部
    h3: '#916844',  // 头发中间调
    h4: '#b2895c',  // 头发高光（挑染）
    e:  '#141a24',  // 眼睛
    l:  '#f8fbff',  // 眼里高光
    m:  '#b8795f',  // 嘴（压在肤色上，不能太红）
    c:  '#537791',  // 外套
    c2: '#3a5a70',  // 外套暗部
    c3: '#2a4356',  // 外套阴影
    t:  '#1b2430',  // 内搭
    p:  '#2c3a4b',  // 裤子
    p2: '#212c3a',  // 裤子暗部
    b:  '#161d27',  // 靴子
    a:  '#e9b76d',  // 琥珀：吊坠 / 皮带扣 / 靴底
    w:  '#c98a4b',  // 木器
    w2: '#e2bb8a',  // 木器亮面
    W:  '#8a5626',  // 木器暗部
    n:  '#fdf6e6',  // 琴弦 / 白键
    g:  '#5b6675',  // 金属
    d:  '#12161d',  // 琴身黑
  };
  /* ---------------- 精灵：一堆 [色, x, y, w, h] ----------------
     栅格 64×80，每格 2px（显示尺寸 128×160）。头发先铺一整块，脸再
     盖上去，发际线自然就有了；所有元素最后统一描一圈外轮廓，整体剪影
     才干净。脚底落在 y=68（下面是 CSS 画的那块台子）。 */
  /* 帅气版：约 2.6 头身，偏分刘海带挑染，细眉细眼，深蓝外套 + 深色
     内搭 + 琥珀吊坠，手上换乐器时手臂会跟着换位置 */
  const HEAD = [
    // 头发：先铺满整个头顶，脸再盖上去
    [C.h, 29, 6, 6, 1],
    [C.h, 27, 7, 10, 1],
    [C.h, 26, 8, 14, 1],
    [C.h, 25, 9, 18, 6],       // 头顶 y9..14
    [C.h, 25, 14, 2, 5],       // 左鬓（到耳下就收），右边长一档
    [C.h, 41, 14, 2, 7],

    // 脸：上宽下窄
    [C.s, 26, 15, 16, 10],     // y15..24
    [C.s, 27, 25, 14, 2],      // y25..26
    [C.s, 28, 27, 12, 1],
    [C.s, 29, 28, 10, 1],      // 下颌 y28
    [C.s, 30, 29, 6, 2],       // 脖子
    [C.s2, 30, 30, 6, 1],

    // 刘海：右边薄一点，露出额头
    [C.h, 26, 14, 16, 1],      // 发际线
    [C.h, 27, 15, 6, 1],
    [C.h, 37, 15, 4, 1],

    // 头发的层次
    [C.h4, 29, 7, 8, 2],       // 顶部高光（挑染）
    [C.h3, 28, 9, 10, 1],
    [C.h2, 39, 10, 4, 5],      // 右侧暗部
    [C.h2, 25, 9, 2, 5],
    [C.h3, 25, 15, 2, 4],      // 左鬓中间调

    // 五官
    [C.h2, 28, 17, 5, 1], [C.h2, 35, 17, 5, 1],   // 眉
    [C.e, 29, 19, 3, 2], [C.e, 36, 19, 3, 2],      // 眼（压扁一点，眼神才利）
    [C.l, 29, 19, 1, 1], [C.l, 36, 19, 1, 1],      // 眼里的光
    [C.s3, 29, 21, 3, 1], [C.s3, 36, 21, 3, 1],    // 下眼睑
    [C.s2, 33, 22, 1, 2],                           // 鼻
    [C.m, 32, 25, 3, 1],                            // 嘴
    [C.s2, 31, 27, 6, 1],                           // 下巴的影
    [C.s2, 41, 18, 1, 6],                           // 右脸颊边缘
  ];

  const TORSO = [
    [C.c, 21, 31, 24, 18],     // 外套 x21..44 y31..48
    [C.c2, 21, 31, 24, 1],     // 肩线
    [C.c3, 21, 32, 1, 17],     // 左边缘
    [C.c2, 41, 32, 4, 17],     // 右侧受光暗
    [C.t, 30, 32, 6, 16],      // 敞开的内搭 x30..35
    [C.c3, 29, 32, 1, 12],     // 领口
    [C.c3, 36, 32, 1, 12],
    [C.c2, 26, 32, 3, 9],      // 翻领
    [C.c2, 38, 32, 3, 9],
    [C.g, 32, 35, 1, 3],       // 吊坠的链子
    [C.a, 31, 38, 3, 3],       // 琥珀吊坠
    [C.p, 23, 49, 20, 2],      // 腰带 y49..50
    [C.a, 32, 49, 4, 2],       // 皮带扣
  ];

  // 腿 + 靴子（靴底一道琥珀色）
  const LEG_L = [[C.p, 26, 51, 6, 10], [C.p2, 30, 51, 1, 10],
                 [C.b, 23, 61, 9, 6], [C.a, 23, 67, 9, 1], [C.b, 23, 61, 2, 7]];
  const LEG_R = [[C.p, 34, 51, 6, 10], [C.p2, 34, 51, 1, 10],
                 [C.b, 34, 61, 9, 6], [C.a, 34, 67, 9, 1], [C.b, 41, 61, 2, 7]];

  // 手臂：垂在身侧，袖子 + 露出的一截手
  const ARM_L = [[C.c, 17, 33, 4, 14], [C.c3, 17, 33, 1, 14], [C.s, 17, 47, 4, 4]];
  const ARM_R = [[C.c, 45, 33, 4, 14], [C.c2, 48, 33, 1, 14], [C.s, 45, 47, 4, 4]];

  /* 琵琶：竖抱在身前，梨形琴身，弦一路拉下来 */
  const PIPA = [
    [C.w, 31, 33, 5, 2],       // 琴头
    [C.W, 32, 35, 3, 11],      // 琴颈
    [C.w, 29, 45, 8, 1],       // 相
    [C.w, 27, 46, 12, 1],      // 琴身：梨形，一行一行收
    [C.w, 26, 47, 14, 5],
    [C.w, 27, 52, 12, 1],
    [C.w, 29, 53, 8, 1],
    [C.w2, 28, 47, 10, 4],     // 面板
    [C.W, 26, 47, 1, 5], [C.W, 39, 47, 1, 5],   // 琴身两侧压暗
    [C.k, 30, 49, 4, 2],       // 音孔
    [C.n, 33, 36, 1, 16],      // 弦
  ];

  /* 钢琴：斜挎在腰前的小键盘，白键朝下 */
  const PIANO = [
    [C.d, 13, 44, 38, 4],      // 琴身
    [C.n, 13, 48, 38, 6],      // 白键
    [C.d, 15, 48, 2, 4], [C.d, 19, 48, 2, 4], [C.d, 23, 48, 2, 4],
    [C.d, 27, 48, 2, 4], [C.d, 31, 48, 2, 4], [C.d, 35, 48, 2, 4],
    [C.d, 39, 48, 2, 4], [C.d, 43, 48, 2, 4], [C.d, 47, 48, 2, 4],
  ];

  /* 小提琴：抱在身前，葫芦形琴身，琴颈指向右，弓竖着拉 */
  const VIOLIN = [
    [C.w, 27, 40, 6, 1],        // 上缘
    [C.w, 25, 41, 10, 4],       // 上半个音箱 y41..44
    [C.w, 27, 45, 6, 2],        // 腰 y45..46
    [C.w, 25, 47, 10, 4],       // 下半个音箱 y47..50
    [C.w, 27, 51, 6, 1],
    [C.w2, 27, 42, 6, 2],       // 面板高光
    [C.k, 26, 43, 1, 1], [C.k, 33, 43, 1, 1],   // f 孔
    [C.k, 26, 48, 1, 1], [C.k, 33, 48, 1, 1],
    [C.n, 29, 44, 1, 7], [C.k, 30, 44, 1, 7],   // 弦
    [C.W, 35, 42, 9, 2],        // 琴颈
    [C.W, 44, 40, 3, 2],        // 琴头
  ];
  const BOW = [
    [C.n, 39, 37, 1, 17],       // 弓杆
    [C.g, 39, 36, 1, 1],
    [C.g, 39, 54, 1, 1],
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
<svg class="muse-svg" viewBox="0 0 64 80" width="128" height="160"
     shape-rendering="crispEdges" aria-hidden="true">
  <g class="muse-root">
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
