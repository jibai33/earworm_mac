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
    f:  '#f7ecdd',  // 主毛色（奶油白）
    f2: '#ddc9b0',  // 毛的暗部
    f3: '#b39d83',  // 毛最暗（脚背、嘴）
    o:  '#e8a765',  // 橘斑（三花）
    o2: '#c9843f',  // 橘斑暗部
    p:  '#e79aa0',  // 粉（耳内、鼻子）
    p2: '#d17f89',  // 深粉（腮红、掌垫）
    e:  '#25333f',  // 眼睛
    l:  '#ffffff',  // 眼里高光
    w:  '#c98a4b',  // 木器
    w2: '#e2bb8a',  // 木器亮面
    W:  '#8a5626',  // 木器暗部
    n:  '#fdf6e6',  // 琴弦 / 白键
    g:  '#5b6675',  // 金属
    d:  '#12161d',  // 琴身黑
  };;
  /* ---------------- 精灵：一堆 [色, x, y, w, h] ----------------
     栅格 64×80，每格 2px（显示 128×160）。整张图先铺毛色，斑纹、耳朵
     再压上去，最后统一描一圈外轮廓。耳朵要高出头顶才有剪影，耳根又得
     落在头的范围里，否则会横着切出一道断线。
     脚底落在 y=66，踩在 CSS 画的台子上。 */
  /* 小猫版：坐姿。大头（比身子宽）+ 尖耳 + 大圆眼，奶油白三花（头顶
     一块橘），前爪带粉色掌垫搭在琴上，尾巴从右边绕上来。
     耳 y5..13，头 y11..35，身子 y35..60，后脚 y56..66。 */
  const HEAD = [
    // 头：横向的圆
    [C.f, 27, 11, 9, 1],
    [C.f, 25, 12, 13, 1],
    [C.f, 23, 13, 19, 1],
    [C.f, 21, 14, 23, 1],
    [C.f, 20, 15, 25, 1],
    [C.f, 19, 16, 27, 1],
    [C.f, 18, 17, 28, 13],     // y17..29 主体
    [C.f, 19, 30, 27, 1],
    [C.f, 20, 31, 25, 1],
    [C.f, 21, 32, 23, 1],
    [C.f, 23, 33, 19, 1],
    [C.f, 25, 34, 13, 1],
    [C.f, 27, 35, 9, 1],

    // 头顶一块橘斑（三花），偏一侧、边缘参差，才不像发带
    [C.o, 27, 11, 9, 1],
    [C.o, 26, 12, 12, 1],
    [C.o, 25, 13, 12, 1],
    [C.o, 23, 14, 13, 1],
    [C.o, 22, 15, 11, 1],
    [C.o2, 27, 13, 10, 1],

    // 耳朵：三角，六行露在头顶之上
    [C.f, 24, 5, 2, 1], [C.f, 23, 6, 4, 1],
    [C.f, 22, 7, 6, 1], [C.f, 22, 8, 8, 6],
    [C.p, 24, 7, 3, 1], [C.p, 24, 8, 3, 3],
    [C.f, 36, 5, 2, 1], [C.f, 35, 6, 4, 1],
    [C.f, 34, 7, 6, 1], [C.f, 34, 8, 8, 6],
    [C.p, 36, 7, 3, 1], [C.p, 36, 8, 3, 3],

    // 大圆眼：中间四行一样宽，上下各收一格
    [C.e, 24, 19, 3, 1], [C.e, 23, 20, 5, 4], [C.e, 24, 24, 3, 1],
    [C.e, 37, 19, 3, 1], [C.e, 36, 20, 5, 4], [C.e, 37, 24, 3, 1],
    [C.l, 23, 20, 2, 2], [C.l, 36, 20, 2, 2],

    // 鼻子 + ω 形嘴
    [C.p, 30, 26, 3, 1],
    [C.p2, 31, 27, 1, 1],
    [C.f3, 30, 28, 1, 1], [C.f3, 33, 28, 1, 1],
    [C.f3, 31, 29, 2, 1],

    // 腮红
    [C.p2, 19, 25, 3, 2],
    [C.p2, 42, 25, 3, 2],
  ];

  const TORSO = [
    [C.f, 26, 35, 12, 1],
    [C.f, 24, 36, 16, 1],
    [C.f, 22, 37, 20, 1],
    [C.f, 21, 38, 22, 14],     // y38..51
    [C.f, 20, 52, 24, 6],      // 下盘 y52..57
    [C.f, 21, 58, 22, 1],
    [C.f, 23, 59, 18, 1],
    [C.f, 25, 60, 14, 1],
    [C.f2, 39, 38, 4, 14],     // 右侧受光暗
    [C.f2, 40, 52, 4, 6],
  ];

  // 后脚：坐在身体两侧前方，圆弧底 + 粉色肉垫
  const LEG_L = [[C.f, 19, 56, 6, 1], [C.f, 18, 57, 8, 1],
                 [C.f, 17, 58, 10, 8], [C.f, 18, 66, 8, 1],
                 [C.f2, 17, 58, 1, 8], [C.p2, 20, 62, 4, 3]];
  const LEG_R = [[C.f, 37, 56, 6, 1], [C.f, 36, 57, 8, 1],
                 [C.f, 37, 58, 10, 8], [C.f, 38, 66, 8, 1],
                 [C.f2, 46, 58, 1, 8], [C.p2, 41, 62, 4, 3]];

  // 前爪：椭圆，搭在琴身上（粉色掌垫在爪底）
  const ARM_L = [[C.f, 23, 38, 4, 4], [C.f2, 23, 38, 1, 9],
                 [C.f, 22, 42, 7, 5], [C.f, 24, 43, 3, 4],
                 [C.p2, 24, 44, 3, 2]];
  const ARM_R = [[C.f, 37, 38, 4, 4], [C.f2, 40, 38, 1, 9],
                 [C.f, 35, 42, 7, 5], [C.f, 37, 43, 3, 4],
                 [C.p2, 37, 44, 3, 2]];

  // 尾巴：从身体右后方绕出来，粗、短、往上钩，尖端橘色
  const TAIL = [
    [C.f, 42, 56, 6, 5],       // 根
    [C.f, 47, 51, 4, 6],
    [C.o, 47, 47, 4, 5],       // 橘色尾尖
  ];

  /* 琵琶：竖抱在身前，梨形琴身，弦一路拉下来 */
  const PIPA = [
    [C.w, 29, 30, 8, 2],       // 琴头
    [C.W, 31, 32, 4, 13],      // 琴颈
    [C.w, 27, 45, 10, 1],      // 相（上端）
    [C.w, 25, 46, 14, 1],
    [C.w, 23, 47, 18, 2],
    [C.w, 22, 49, 20, 5],      // 琴身最宽 y49..53
    [C.w, 23, 54, 18, 1],
    [C.w, 25, 55, 14, 1],
    [C.w2, 26, 47, 12, 6],     // 面板
    [C.W, 23, 47, 18, 1],      // 琴身上缘
    [C.k, 29, 51, 4, 2],       // 音孔
    [C.n, 32, 33, 1, 17],      // 弦
  ];

  /* 钢琴：横在身前的小键盘，白键朝下 */
  const PIANO = [
    [C.d, 20, 45, 24, 4],      // 琴身 y45..48
    [C.n, 20, 49, 24, 5],      // 白键 y49..53
    [C.d, 22, 49, 2, 3], [C.d, 27, 49, 2, 3], [C.d, 32, 49, 2, 3],
    [C.d, 37, 49, 2, 3], [C.d, 41, 49, 2, 3],
  ];

  /* 小提琴：抱在胸前，葫芦形琴身，琴颈指向右，弓竖着拉 */
  const VIOLIN = [
    [C.w, 27, 39, 10, 1],
    [C.w, 25, 40, 14, 4],      // 上半个音箱 y40..43
    [C.w, 27, 44, 10, 2],      // 腰 y44..45
    [C.w, 25, 46, 14, 4],      // 下半个音箱 y46..49
    [C.w, 27, 50, 10, 1],
    [C.w2, 28, 41, 8, 2],      // 面板高光
    [C.k, 26, 42, 1, 1], [C.k, 37, 42, 1, 1],    // f 孔
    [C.k, 26, 47, 1, 1], [C.k, 37, 47, 1, 1],
    [C.n, 31, 43, 1, 6], [C.k, 32, 43, 1, 6],    // 弦
    [C.W, 39, 42, 6, 2],       // 琴颈
    [C.W, 44, 40, 3, 2],       // 琴头
  ];
  const BOW = [
    [C.n, 40, 36, 1, 15],      // 弓杆
    [C.g, 40, 35, 1, 1],
    [C.g, 40, 51, 1, 1],
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
    <g class="muse-tail">${layer(TAIL)}</g>
    <g class="muse-torso">${layer(TORSO)}</g>
    <g class="muse-leg muse-leg-l">${layer(LEG_L)}</g>
    <g class="muse-leg muse-leg-r">${layer(LEG_R)}</g>
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
