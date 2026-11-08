/* ====================================================================
 * 闻曲 · 搜曲页个性化推荐（采集挂载 + 渲染）
 * 依赖：taste.js（平台无关画像客户端）、app.js（播放器全局函数）
 * 通过包装现有播放器函数挂载行为采集，不侵入播放器主逻辑。
 * ==================================================================== */
(function () {
  'use strict';
  if (typeof Taste === 'undefined') return;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const artist = (s) => String((s && s.artist) || '').split(/[\/,、&]/)[0].trim();

  let rec = null, variant = 0, busy = false, booted = false, offline = '';

  /* ---------- 采集挂载 ---------- */
  function wrap(name, before, after) {
    const orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = function (...args) {
      try { if (before) before(args); } catch (e) { console.warn('[taste] before', name, e); }
      const r = orig.apply(this, args);
      try { if (after) after(r, args); } catch (e) { console.warn('[taste] after', name, e); }
      return r;
    };
  }
  const songOf = (s) => ({
    id: String((s && s.id) || ''), name: String((s && s.name) || ''),
    artist: String((s && s.artist) || ''), provider: String((s && s.provider) || 'netease'),
    cover: String((s && s.cover) || ''),
  });
  const currentSong = () => (state && state.queue[state.index]) || null;

  // 不写死 platform：由 taste.js 自动区分 web / ios-pwa / android-pwa；
  // 原生 macOS / iOS 客户端加载同一脚本时自行传入 platform 即可
  Taste.init({ urlFn: (p) => window.apiUrl(p) });

  wrap('pushHist', null, (_r, args) => {
    Taste.track('search', { meta: { keyword: args[0], context: state ? state.provider : 'netease' } });
  });
  wrap('doSearch', null, () => hideTaste());
  wrap('openSearchDrop', null, () => {
    const input = $('search-input');
    if (!input || (!input.value.trim() && !$('results').children.length)) showTaste();
    else hideTaste();
  });
  wrap('playIndex', (args) => {
    // 上一首没听到 30% 就切走 = 跳过（弱负信号）
    const a = audio, st = state;
    if (!a || !st || !a.src || a.paused || !a.duration) return;
    if (args[0] === st.index || a.currentTime / a.duration >= 0.3) return;
    const prev = st.queue[st.index];
    if (prev) Taste.track('skip', { song: songOf(prev) });
  });
  wrap('openPlaylist', null, (r) => {
    const done = () => Taste.track('view', { meta: { context: ($('pl-name') || {}).textContent || '歌单', keyword: '' } });
    if (r && typeof r.then === 'function') r.then(done, () => {});
    else done();
  });
  wrap('openXYPodcast', null, (_r, args) => {
    Taste.track('view', { meta: { context: '小宇宙 · 单集 ' + String(args[0] || '') } });
  });
  wrap('toggleLike', null, () => {
    const s = currentSong();
    if (s) Taste.track('like', { song: songOf(s) });
  });

  if (typeof audio !== 'undefined' && audio) {
    audio.addEventListener('playing', () => {
      const s = currentSong();
      if (s) Taste.track('play', { song: songOf(s), meta: { duration: s.duration || 0 } });
    });
    audio.addEventListener('ended', () => {
      const s = currentSong();
      if (s) Taste.track('complete', { song: songOf(s) });
    });
  }
  $('search-input').addEventListener('input', () => {
    if (!$('search-input').value.trim() && !$('results').children.length) showTaste();
  });

  /* ---------- 首次启动：bootstrap + 迁移本机搜索历史 ---------- */
  function migrateHistory() {
    let h = [];
    try { h = JSON.parse(localStorage.getItem('ew_hist') || '[]'); } catch { /* ignore */ }
    if (!h.length || localStorage.getItem('ew_hist_migrated')) return;
    h.slice(0, 10).forEach(kw => Taste.track('search', { meta: { keyword: kw, context: 'history' } }));
    localStorage.setItem('ew_hist_migrated', '1');
    Taste.flush(true);
  }
  Taste.bootstrap().then((r) => {
    booted = true;
    offline = '';
    migrateHistory();
    if (!$('page-search').hidden && !$('search-input').value.trim()) loadTaste(true);
    return r;
  }).catch((e) => {
    booted = false;
    offline = '连不上画像服务：' + e.message + '。记录会先存在本机，恢复后自动补报。';
    const sub = $('tr-sub');
    if (sub) sub.textContent = offline;
  });

  /* ---------- 显示 / 隐藏 ---------- */
  function showTaste() {
    const box = $('taste-rec');
    if (!box) return;
    box.hidden = false;
    $('page-search').classList.add('taste-open');
    loadTaste(false);
  }
  function hideTaste() {
    const box = $('taste-rec');
    if (box) box.hidden = true;
    $('page-search').classList.remove('taste-open');
  }

  async function loadTaste(force) {
    if (busy) return;
    if (!booted || offline) {
      $('tr-sub').textContent = offline || '正在读取你的听感画像……';
      return;
    }
    if (rec && !force) { renderTaste(); return; }
    busy = true;
    $('tr-sub').textContent = '正在按你的听感生成……';
    try {
      const r = await Taste.recommend(variant);
      rec = (r && r.recommendations) || null;
      if (!rec) throw new Error('推荐数据为空');
      renderTaste();
    } catch (e) {
      offline = '推荐暂时生成不出来：' + e.message;
      $('tr-sub').textContent = offline;
      $('tr-hero').innerHTML = '';
      $('tr-cards').innerHTML = '';
      $('tr-list').innerHTML = '';
    } finally { busy = false; }
  }

  /* ---------- 渲染 ---------- */
  function renderTaste() {
    if (!rec) return;
    const s = rec.summary || {};
    const status = rec.status;
    $('tr-sub').textContent = status === 'ready'
      ? `据近 ${s.windowDays || 30} 天 ${s.listen || 0} 次收听 · ${s.search || 0} 次搜索 · ${s.view || 0} 次浏览生成 · ${s.devices || 1} 台设备共用画像`
      : status === 'cold_start'
        ? '记录还在积累，先挑个喜欢的风格也可以'
        : '个性化已关闭，只保留曾闻与热门';

    const chips = (rec.signals || []).map((x, i) =>
      `<span class="tr-chip ${i === 0 ? 'cur' : ''}">${esc(x.label)} <b>${esc(x.value)}</b></span>`).join('');
    $('tr-signals').innerHTML = chips + '<span class="tr-chip" id="tr-why">为什么推荐这些</span>';
    const why = $('tr-why');
    if (why) why.onclick = openSettings;

    renderHero();
    renderCards();
    renderList();
    $('tr-foot-note').textContent = status === 'ready'
      ? `推荐每小时更新 · 记录仅存于此服务，同步码 ${Taste.getSyncKey() || '—'}`
      : '记录只用于生成推荐，可随时关闭或清除';
    $('tr-off').textContent = status === 'disabled' ? '开启个性化' : '关闭个性化';
    $('tr-off').onclick = async () => {
      await Taste.settings({ enabled: status === 'disabled' });
      rec = null;
      loadTaste(true);
    };
  }

  function renderHero() {
    const box = $('tr-hero');
    const r = rec.radio;
    if (!r) {
      const ob = rec.onboarding || {};
      const styles = (ob.styles || []).map(x => `<span class="tr-chip">${esc(x)}</span>`).join('');
      box.innerHTML = `<div class="tr-empty">
        <b style="color:var(--txt)">${esc(ob.title || '先听几首，我再懂你')}</b><br>${esc(ob.hint || '')}
        ${styles ? `<div class="tr-styles">${styles}</div>` : ''}
        ${rec.status === 'disabled' ? '<div class="tr-styles"><button class="tr-btn solid" id="tr-on">开启个性化</button></div>' : ''}
      </div>`;
      box.querySelectorAll('.tr-chip').forEach(c => { c.onclick = () => { $('search-input').value = c.textContent.trim(); window.doSearch(c.textContent.trim()); }; });
      const on = $('tr-on');
      if (on) on.onclick = async () => { await Taste.settings({ enabled: true }); rec = null; loadTaste(true); };
      return;
    }
    const tracks = r.tracks || [];
    const line = tracks.slice(0, 3).map((t, i) => `${String(i + 1).padStart(2, '0')} ${esc(t.name)} · ${esc(artist(t))}`).join('　');
    const trace = (r.trace || []).map(t => `<div class="tr-trace-line">${esc(t)}</div>`).join('');
    box.innerHTML = `
      <div class="tr-hero-cover"><span>夜</span><i>为你生成</i></div>
      <div class="tr-hero-main">
        <div class="tr-kicker">${esc(r.kicker || 'MIX · 私人墨色电台')}</div>
        <div class="tr-name">${esc(r.title)}</div>
        <div class="tr-reason">${esc(r.reason)}</div>
        <div class="tr-trackline">${line}</div>
        <div class="tr-hero-actions">
          <button class="tr-btn solid" id="tr-playall">播放全部</button>
          <button class="tr-btn" id="tr-collect">收藏这单</button>
          <span class="tr-reason">${esc(r.meta || `${tracks.length} 首`)}</span>
        </div>
      </div>
      <div class="tr-hero-trace">
        <div class="tr-trace-h">为什么是这几首</div>
        ${trace}
        <button class="tr-trace-link" id="tr-adjust">调整这些依据 ›</button>
      </div>`;
    $('tr-playall').onclick = () => {
      if (!tracks.length) return;
      state.queue = tracks.slice();
      window.renderQueue();
      window.playIndex(0);
      hideTaste();
    };
    $('tr-collect').onclick = () => { Taste.track('like', { song: songOf(tracks[0] || {}) }); $('tr-collect').textContent = '已记下'; };
    $('tr-adjust').onclick = openSettings;
  }

  function renderCards() {
    const cards = rec.cards || [];
    $('tr-cards').innerHTML = cards.map((c, i) => `
      <div class="tr-card" data-type="${esc(c.type)}">
        <div class="tr-card-k">${esc(c.kicker)}</div>
        <div class="tr-card-t">${esc(c.title)}</div>
        <div class="tr-card-d">${esc(c.desc)}</div>
        ${c.type === 'continue' ? '<div class="tr-progress"><i></i></div>' : ''}
        <button class="tr-card-a" data-card="${i}">${esc(c.action)} ›</button>
      </div>`).join('');
    $('tr-cards').querySelectorAll('[data-card]').forEach(btn => {
      btn.onclick = () => {
        const c = cards[Number(btn.dataset.card)];
        if (!c) return;
        if (c.type === 'continue' && c.song) {
          state.queue = [c.song];
          window.renderQueue();
          window.playIndex(0);
          hideTaste();
        } else {
          const kw = c.keyword || c.title;
          $('search-input').value = kw;
          window.doSearch(kw);
        }
      };
    });
  }

  function renderList() {
    const list = rec.suggestions || [];
    if (!list.length) {
      $('tr-list').innerHTML = '<div class="tr-empty">还没有可推荐的曲目，多听几首就会有了。</div>';
      return;
    }
    $('tr-list').innerHTML = `
      <div class="tr-list-head"><span>猜你会喜欢</span><button id="tr-all">换一批 ›</button></div>
      ${list.map((s, i) => `
        <div class="tr-song" data-song="${i}">
          <span class="tr-song-i">${String(i + 1).padStart(2, '0')}</span>
          <img src="${coverUrl(s.cover) || 'icon.svg'}" alt="" loading="lazy">
          <span class="tr-song-n">${esc(s.name)} · ${esc(artist(s))}</span>
          <span class="tr-song-r">${esc(s.reason)}</span>
          <button class="tr-song-x" data-dismiss="${i}">不感兴趣 ×</button>
        </div>`).join('')}`;
    const all = $('tr-all');
    if (all) all.onclick = () => { variant++; loadTaste(true); };
    $('tr-list').querySelectorAll('[data-song]').forEach(el => {
      el.onclick = (e) => {
        if (e.target.closest('[data-dismiss]')) return;
        const s = list[Number(el.dataset.song)];
        if (!s) return;
        state.queue = list.slice();
        window.renderQueue();
        window.playIndex(Number(el.dataset.song));
        hideTaste();
      };
    });
    $('tr-list').querySelectorAll('[data-dismiss]').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const s = list[Number(btn.dataset.dismiss)];
        if (!s) return;
        Taste.feedback('song', s.name, 'dislike').then(() => { variant++; loadTaste(true); });
        btn.parentElement.remove();
      };
    });
  }

  $('tr-refresh').onclick = () => { variant++; loadTaste(true); };
  $('tr-settings').onclick = openSettings;

  /* ---------- 画像设置面板 ---------- */
  function openSettings() {
    $('tk-code').textContent = Taste.getSyncKey() || '—';
    $('tk-enabled').checked = Taste.isEnabled();
    setStatus('');
    $('taste-modal').hidden = false;
  }
  function setStatus(msg, isErr) {
    const el = $('tk-status');
    el.textContent = msg || '';
    el.classList.toggle('err', !!isErr);
  }
  $('tk-close').onclick = () => { $('taste-modal').hidden = true; rec = null; loadTaste(true); };
  $('tk-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(Taste.getSyncKey()); setStatus('已复制，去另一端粘贴即可'); }
    catch { setStatus('复制失败，请手动选中同步码', true); }
  };
  $('tk-new').onclick = async () => {
    try { const r = await Taste.createSyncKey(); $('tk-code').textContent = r.syncKey || Taste.getSyncKey(); setStatus('已生成新同步码，旧画像已合并进来'); }
    catch (e) { setStatus(e.message, true); }
  };
  $('tk-bind').onclick = async () => {
    const v = $('tk-input').value.trim();
    if (!v) return setStatus('请先填入另一端显示的同步码', true);
    try {
      const r = await Taste.bindSyncKey(v);
      if (!r || r.ok === false) return setStatus((r && r.error) || '绑定失败', true);
      $('tk-code').textContent = r.syncKey;
      Taste.track('view', { meta: { context: '跨端画像合并' } });
      setStatus('绑定成功，两台设备的记录已合并');
      rec = null; loadTaste(true);
    } catch (e) { setStatus(e.message, true); }
  };
  $('tk-enabled').onchange = async (e) => {
    try { await Taste.settings({ enabled: e.target.checked }); setStatus(e.target.checked ? '已开启记录' : '已停止记录，推荐也会关闭'); rec = null; }
    catch (err) { setStatus(err.message, true); }
  };
  $('tk-export').onclick = async () => {
    try {
      const d = await Taste.exportData();
      const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'earworm-taste-profile.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      setStatus('已导出全部画像数据');
    } catch (e) { setStatus(e.message, true); }
  };
  $('tk-clear').onclick = async () => {
    if (!confirm('将清除服务端与所有共用设备上的收听、搜索、浏览记录，且无法恢复。确定继续？')) return;
    try { await Taste.clear(); setStatus('记录已清除'); rec = null; loadTaste(true); }
    catch (e) { setStatus(e.message, true); }
  };
})();
