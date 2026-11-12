/* ====================================================================
   闻曲 · 首页「听感层」
   ---------------------------------------------------------------
   · 唱片墙预览 / 年鉴摘要 / 唱片店进度：全部来自已存在的只读接口，
     首页不新增任何数据源，也不复制一份状态
   · 主卡右上「此刻在响」读 window.__ewSpectrum —— 和菜单栏图标同一组数
     值，所以两边永远同步；暂停时落回基线
   · 任何一块取不到就安静降级成空态，不弹错误、不影响其余卡片
   ==================================================================== */
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const syncKey = () => (window.Taste && Taste.getSyncKey && Taste.getSyncKey()) || '';

  const state = { wall: null, yb: null, crate: null, loading: false, lastAt: 0 };

  /* ---------------- 数据 ---------------- */

  async function fetchAll(force) {
    if (state.loading) return;
    if (!force && state.wall && Date.now() - state.lastAt < 30000) { renderAll(); return; }
    state.loading = true;
    const key = encodeURIComponent(syncKey());
    const [wall, yb, crate] = await Promise.all([
      window.EW.api(`/api/taste/wall?syncKey=${key}`).catch(() => null),
      window.EW.api(`/api/taste/yearbook?syncKey=${key}&period=month`).catch(() => null),
      window.EW.api(`/api/crate/status?syncKey=${key}`).catch(() => null),
    ]);
    if (wall) state.wall = wall;
    if (yb) state.yb = yb;
    if (crate) state.crate = crate;
    state.lastAt = Date.now();
    state.loading = false;
    renderAll();
  }

  /* ---------------- 唱片墙预览 ---------------- */

  function renderWall() {
    const d = state.wall;
    const strip = $('hw-strip');
    if (!strip) return;
    const CAP = 24;
    if (!d) { strip.classList.add('is-empty'); strip.innerHTML = '<div class="hw-tile pin"></div>'.repeat(8); return; }

    $('hw-meta').textContent = `${d.hung} / ${d.capacity}`;
    // 今天一张都没挂：只画一排钉子示意，不要把 24 个空格铺满整屏
    if (!d.total) {
      strip.classList.add('is-empty');
      strip.innerHTML = '<div class="hw-tile pin"></div>'.repeat(8);
      $('hw-note').textContent = '今天墙上还空着，听一首就挂上了';
      return;
    }
    strip.classList.remove('is-empty');
    // 首页只挂 8 格（两行）：v2 回看三卡等宽后，24 格会把整行撑到半屏高。
    // 整面墙去唱片墙页看，这里只是「今天挂了什么」的一眼概览。
    const VIS = 8;
    const all = (d.slots && d.slots.length ? d.slots : new Array(d.capacity || CAP).fill(null));
    const slots = all.slice(0, VIS);
    strip.innerHTML = '';
    slots.forEach((s, i) => {
      if (!s) {
        const pin = document.createElement('div');
        pin.className = 'hw-tile pin';
        strip.appendChild(pin);
        return;
      }
      const tile = document.createElement('div');
      // 同上：只让最新的那张亮着
      tile.className = 'hw-tile' + (s.fresh && i === 0 ? ' is-fresh' : '') + (s.cover ? '' : ' no-cover');
      tile.title = `${s.name}${s.artist ? ' — ' + s.artist : ''}`;
      if (s.cover) {
        const img = document.createElement('img');
        img.src = window.EW.coverUrl(s.cover);
        img.alt = '';
        img.loading = 'lazy';
        img.addEventListener('error', () => { img.remove(); tile.classList.add('no-cover'); }, { once: true });
        tile.appendChild(img);
      }
      strip.appendChild(tile);
    });

    const note = $('hw-note');
    note.textContent = d.total > VIS
      ? `今天 ${d.total} 首 · 首页先看 ${VIS} 张`
      : `今天挂上 ${d.hung} 张`;
  }

  /* ---------------- 年鉴摘要 ---------------- */

  function renderYearbook() {
    const d = state.yb;
    const title = $('hy-title');
    const nums = $('hy-nums');
    const chart = $('hy-chart');
    if (!title || !nums || !chart) return;

    if (!d || d.empty) {
      $('hy-period').textContent = `${new Date().getMonth() + 1} 月`;
      title.textContent = (d && d.title) || '这个月还是白的';
      nums.innerHTML = '';
      const dek0 = $('hy-dek');
      if (dek0) dek0.textContent = (d && d.dek) || '';
      chart.innerHTML = new Array(24).fill('<span class="hy-bar"></span>').join('');
      $('hy-note').textContent = '本月 · 本机记录 · 不出网';
      return;
    }

    $('hy-period').textContent = `${new Date().getMonth() + 1} 月`;
    title.textContent = d.headline && d.headline.title ? d.headline.title : '这段时间，你在听';
    const n = d.nums || {};
    nums.innerHTML = `
      <div class="hy-num"><b>${Number(n.plays) || 0}</b><span>首</span></div>
      <div class="hy-num"><b>${Number(n.songs) || 0}</b><span>种</span></div>
      <div class="hy-num"><b>${Number(n.completeRate) || 0}%</b><span>听完</span></div>`;

    const dek = $('hy-dek');
    if (dek) dek.textContent = (d.headline && d.headline.dek) || '';

    const hours = Array.isArray(d.hours) ? d.hours : new Array(24).fill(0);
    const max = Math.max(1, ...hours);
    const peakH = new Set((d.peaks || []).map((p) => p.h));
    chart.innerHTML = hours.map((v, h) => {
      const hh = v ? Math.max(3, Math.round((v / max) * 34)) : 2;
      const cls = 'hy-bar' + (v ? ' on' : '') + (v && peakH.has(h) ? ' peak' : '');
      return `<span class="${cls}" style="height:${hh}px" title="${h} 点 · ${v} 首"></span>`;
    }).join('');

    $('hy-note').textContent = '本月 · 本机记录 · 不出网';
  }

  /* ---------------- 唱片店进度 ---------------- */

  function renderCrate() {
    const d = state.crate;
    const box = $('sp-crate-dots');
    if (!box) return;
    if (!d) {
      $('sp-crate-count').textContent = '— / 8';
      $('sp-crate-hint').textContent = '抽屉还没打开';
      box.innerHTML = '<span class="sc-dot"></span>'.repeat(8);
      return;
    }
    $('sp-crate-count').textContent = `${d.count} / ${d.total}`;
    box.innerHTML = (d.records || []).map((r) => `<span class="sc-dot${r.unlocked ? ' on' : ''}" title="${esc(r.title)}${r.unlocked ? ' · 已解锁' : ' · ' + esc(r.how)}"></span>`).join('');
    $('sp-crate-hint').textContent = d.next ? `下一张：${d.next.how}` : '八张都齐了。';
    $('sp-crate').title = d.next ? `下一张：${d.next.title} — ${d.next.hint}` : '八张都齐了';
  }

  function renderAll() {
    try { renderWall(); } catch { /* 单块失败不影响其他 */ }
    try { renderYearbook(); } catch { /* ignore */ }
    try { renderCrate(); } catch { /* ignore */ }
  }

  /* ---------------- 此刻在响：8 段电平 ---------------- */

  function initMeter() {
    const wrap = $('hero-meter');
    const box = $('hm-bars');
    const label = $('hm-label');
    if (!wrap || !box) return;
    box.innerHTML = new Array(8).fill('<span class="hm-bar"></span>').join('');
    const bars = [...box.children];
    const audio = $('audio');
    let lastKey = '';

    const frame = () => {
      const list = window.__ewSpectrum;
      const playing = !!(audio && !audio.paused && !audio.ended);
      const live = playing && Array.isArray(list) && list.length === 8;
      wrap.classList.toggle('is-idle', !live);
      if (label) label.textContent = playing ? (live ? 'NOW' : '…') : 'IDLE';
      if (live) {
        // 与菜单栏保持一致：0~1 → 2~38px，静音时也留 2px 基线
        const key = list.map((v) => Math.round(v * 24)).join(',');
        if (key !== lastKey) {
          lastKey = key;
          bars.forEach((b, i) => { b.style.height = `${Math.max(2, Math.round(list[i] * 38))}px`; });
        }
      } else { lastKey = ''; }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  /* ---------------- 绑定 ---------------- */

  function bindClick(el, fn) {
    if (!el) return;
    el.addEventListener('click', fn);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); }
    });
  }

  function bind() {
    initMeter();

    bindClick($('home-wall-card'), () => window.EW.go('page-wall'));
    bindClick($('home-yb-card'), () => window.EW.go('page-yearbook'));
    bindClick($('sp-crate'), () => {
      if (window.Crate && Crate.openPage) Crate.openPage();
      else window.EW.go('page-crate');
    });
    const night = $('sp-night');
    if (night) night.addEventListener('click', () => window.EW.go('page-midnight'));

    document.addEventListener('ew:page', (e) => {
      if (e.detail === 'page-discover') fetchAll(true);
    });

    // 听着听着墙和年鉴会长大：首页可见时每 45 秒轻轻刷新一次
    setInterval(() => {
      const home = $('page-discover');
      if (!home || home.hidden) return;
      if (document.visibilityState !== 'visible') return;
      fetchAll(true);
    }, 45000);

    // v2：唱片店解锁时左栏进度立刻跟上，不必等下一次 45s 静默刷新
    document.addEventListener('ew:crate-unlock', () => fetchAll(true));

    fetchAll(false);
  }

  window.HomeExtra = { refresh: () => fetchAll(true), debug: () => ({ wall: !!state.wall }) };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
})();
