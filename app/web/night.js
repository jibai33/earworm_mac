/* ====================================================================
   闻曲 · 深夜频道（前端）
   ---------------------------------------------------------------
   · 0–5 点自动接管：切深蓝令牌、首页顶部出现提示条、顶栏出现「夜」按钮
   · 曲单来自 /api/taste/night（只取慢的），点一行直接播
   · 「给我一首意外的」走 /api/taste/surprise：从权重最低的方向抽
   · 一切都能手动退出（今晚不熬夜），退出后到次日 0 点前不再自动进入
   ==================================================================== */
(function () {
  const $ = (id) => document.getElementById(id);
  const LS_FORCE = 'ew_night_force';   // 'on' | 'off' | 空=按时间
  const LS_OPT_OUT = 'ew_night_optout'; // 退出的日期（当天不再自动进入）
  const NIGHT_START = 0;
  const NIGHT_END = 5;

  const state = { tracks: [], loadedAt: 0, loading: false, hint: '', playing: -1 };

  /* ---------- 时间与激活状态 ---------- */
  function hourNow() { return new Date().getHours(); }
  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }
  function inNightHours() {
    const h = hourNow();
    return h >= NIGHT_START && h < NIGHT_END;
  }
  function forced() {
    try { return localStorage.getItem(LS_FORCE) || ''; } catch { return ''; }
  }
  function optedOutToday() {
    try { return localStorage.getItem(LS_OPT_OUT) === todayKey(); } catch { return false; }
  }
  function isActive() {
    const f = forced();
    if (f === 'on') return true;
    if (f === 'off') return false;
    return inNightHours() && !optedOutToday();
  }

  function applyTheme() {
    const on = isActive();
    document.body.classList.toggle('midnight', on);
    const strip = $('night-strip');
    if (strip) strip.hidden = !on;
    const nav = $('nav-night');
    if (nav) {
      nav.hidden = !on;
      nav.classList.toggle('on', on);
      nav.title = on ? '深夜频道 · 现在只放慢的' : '深夜频道';
    }
    if (on) {
      tickClock();
      // 进入页面时才拉曲单，避免每次启动都多打一次检索
      if (!$('page-midnight').hidden) loadTracks(false);
    }
  }

  function tickClock() {
    const el = $('night-clock');
    if (!el) return;
    const d = new Date();
    el.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  /* ---------- 取曲单 ---------- */
  async function loadTracks(force) {
    if (state.loading) return;
    if (!force && state.tracks.length && Date.now() - state.loadedAt < 5 * 60 * 1000) return;
    state.loading = true;
    const list = $('night-list');
    if (list && !state.tracks.length) list.innerHTML = '<li class="night-empty">正在翻找慢的曲子……</li>';
    try {
      const key = (window.Taste && Taste.getSyncKey && Taste.getSyncKey()) || '';
      const r = await window.EW.api(`/api/taste/night?syncKey=${encodeURIComponent(key)}`);
      state.tracks = Array.isArray(r.tracks) ? r.tracks : [];
      state.loadedAt = Date.now();
      renderTracks();
      const ex = $('night-explain');
      if (ex && r.explain) ex.textContent = `${r.explain.rule}。${r.explain.source}。`;
    } catch (e) {
      if (list) list.innerHTML = `<li class="night-empty">曲单取不到：${e.message}</li>`;
    } finally {
      state.loading = false;
    }
  }

  function fmt(s) {
    s = Math.max(0, Math.floor((s || 0) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function renderTracks() {
    const list = $('night-list');
    if (!list) return;
    const count = $('night-count');
    if (count) count.textContent = `${state.tracks.length} 首 · 由「慢」标签筛出`;
    if (!state.tracks.length) {
      list.innerHTML = '<li class="night-empty">这个点太安静了，连曲库都睡着了。稍后再试。</li>';
      return;
    }
    list.innerHTML = '';
    state.tracks.forEach((s, i) => {
      const li = document.createElement('li');
      li.className = 'nl-row' + (i === state.playing ? ' cur' : '');
      li.dataset.i = String(i);
      const cover = s.cover ? window.EW.coverUrl(s.cover) : '';
      li.innerHTML = `
        <span class="nl-idx">${String(i + 1).padStart(2, '0')}</span>
        <span class="nl-cover"${cover ? ` style="background-image:url('${cover}')"` : ''}></span>
        <span class="nl-meta"><b>${escapeHtml(s.name || '')}</b><i>${escapeHtml(s.artist || '')}</i></span>
        <span class="nl-dur">${fmt(s.duration)}</span>`;
      li.addEventListener('click', () => playAt(i));
      list.appendChild(li);
    });
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  }

  function playAt(i) {
    if (!state.tracks.length) return;
    state.playing = i;
    window.EW.play(state.tracks, i);
    renderTracks();
  }

  /* ---------- 意外的一首 ---------- */
  async function surprise() {
    const btn = $('night-surprise');
    const hint = $('night-hint');
    if (btn) { btn.disabled = true; btn.textContent = '正在抽……'; }
    try {
      const key = (window.Taste && Taste.getSyncKey && Taste.getSyncKey()) || '';
      const r = await window.EW.api(`/api/taste/surprise`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ syncKey: key }),
      });
      if (!r.ok || !r.song) throw new Error(r.error || '没抽到');
      window.EW.play([r.song], 0);
      if (hint) hint.textContent = r.reason;
      state.playing = -1;
      // 「意外的一首」用过一次 → 唱片店 SIDE D
      window.EW.api('/api/crate/mark', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ what: 'odd' }),
      }).catch(() => {});
    } catch (e) {
      if (hint) hint.textContent = `抽不到：${e.message}`;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '给我一首意外的'; }
    }
  }

  /* ---------- 页面切换 ---------- */
  function openPage() {
    window.EW.go('page-midnight');
    loadTracks(false);
    // 进过深夜频道就记一笔：唱片店「雨夜电台」的解锁依据
    if (isActive()) {
      window.EW.api('/api/crate/mark', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ what: 'rain' }),
      }).catch(() => {});
    }
  }

  function bind() {
    const nav = $('nav-night');
    if (nav) nav.addEventListener('click', openPage);
    const goBtn = $('night-strip-go');
    if (goBtn) goBtn.addEventListener('click', openPage);
    const back = $('night-strip') && $('night-strip');
    if (back) back.addEventListener('click', (e) => { if (e.target === back) openPage(); });

    const sp = $('night-surprise');
    if (sp) sp.addEventListener('click', surprise);
    const rf = $('night-refresh');
    if (rf) rf.addEventListener('click', () => loadTracks(true));
    const ex = $('night-exit');
    if (ex) {
      ex.addEventListener('click', () => {
        try {
          localStorage.setItem(LS_FORCE, '');
          localStorage.setItem(LS_OPT_OUT, todayKey());
        } catch { /* 私密模式 */ }
        applyTheme();
        window.EW.go('page-discover');
      });
    }

    document.addEventListener('ew:page', (e) => {
      if (e.detail === 'page-midnight') loadTracks(false);
    });

    // 跨过 5 点、或夜里醒来：每分钟对一次表
    setInterval(() => {
      const was = document.body.classList.contains('midnight');
      if (was !== isActive()) applyTheme();
      tickClock();
    }, 30000);
  }

  window.Night = {
    isActive, openPage, loadTracks, applyTheme, surprise,
    debug: () => ({ active: isActive(), hour: hourNow(), tracks: state.tracks.length }),
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { bind(); applyTheme(); }, { once: true });
  } else { bind(); applyTheme(); }
})();
