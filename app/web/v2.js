/* ====================================================================
   闻曲 v2 · 整体设计方案的前端落地
   ------------------------------------------------------------------
   ① 回听闭环：墙 / 年鉴 / 去年今天 / 今日一曲，全部汇到同一条播放队列
   ② 30 天热度条：点方块跳到那天的墙
   ③ 今日一曲：每天只出一次，播过盖章；反画像抽曲白天也能用
   ④ ⌘K 命令面板 / 成就解锁即时反馈 / 深夜手动开关 / 首周空态给动作

   约束：不新建页面、不新增数据源、不复制状态。数据全部来自
   /api/taste/* 的只读接口；播放统一走 window.EW.play / EW.replay。
   ==================================================================== */
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const EW = () => window.EW;
  const api = (p, o) => EW().api(p, o);
  const key = () => (window.Taste && Taste.getSyncKey && Taste.getSyncKey()) || '';
  const kq = () => encodeURIComponent(key());
  const toast = (m, warn) => { if (EW() && EW().toast) EW().toast(m, warn); };

  const state = {
    daily: null, heat: null, lastyear: null,
    crateCount: null, crateIds: null,
    loading: false, lastAt: 0,
    cmdOpen: false, cmdItems: [], cmdIndex: 0, cmdSeq: 0, cmdTimer: 0,
    undo: 0, midnightWas: null,
  };

  /* ================= ① 回听动作：唯一出口 ================= */

  function replayDay(day, label, todayOnly) {
    // todayOnly：首页 / 命令面板说的「今天」，不跟墙页当前翻到的日期走
    const d = todayOnly ? '' : (day || (window.Wall && Wall.debug && Wall.debug().day) || '');
    return EW().replay({ scope: 'day', day: d, source: label || '那天的墙' }, label || '这一天');
  }
  function replayPeriod(period) {
    const p = period || (window.Yearbook && Yearbook.debug && Yearbook.debug().period) || 'month';
    const CN = { year: '年刊', month: '月鉴', week: '周鉴' };
    return EW().replay({ scope: 'period', period: p, source: CN[p] || '这一期' }, CN[p] || '这一期');
  }
  function replayLastYear() {
    return EW().replay({ scope: 'lastyear', source: '去年今天' }, '去年今天');
  }

  /* ================= ③ 今日一曲 ================= */

  async function loadDaily(force) {
    const card = $('v2-daily');
    if (!card) return;
    try {
      const q = force ? '&t=' + Date.now() : '';
      const d = await api(`/api/taste/daily?syncKey=${kq()}${q}`);
      state.daily = d || null;
      renderDaily();
    } catch (e) {
      state.daily = { ok: true, empty: true, line: '今天先挂上第一张', note: '服务暂时取不到，先去听一首。' };
      renderDaily();
    }
  }

  function renderDaily() {
    const card = $('v2-daily');
    if (!card) return;
    const d = state.daily;
    const songEl = $('v2-daily-song');
    const lineEl = $('v2-daily-line');
    const dateEl = $('v2-daily-date');
    const stamp = $('v2-daily-stamp');
    const btn = $('v2-daily-play');
    const cover = $('v2-daily-cover');
    if (!d) {
      card.classList.add('is-loading');
      songEl.textContent = '正在挑今天这一张……';
      lineEl.textContent = '一首歌，一天一次。';
      return;
    }
    card.classList.remove('is-loading');
    card.classList.toggle('is-empty', !!d.empty);
    if (d.empty) {
      songEl.textContent = '今天还没有属于你的一曲';
      lineEl.textContent = d.line || '今天先挂上第一张';
      dateEl.textContent = d.note || '去听一首，明天这里就会有记录';
      if (btn) btn.textContent = '▶ 去听推荐';
      if (stamp) stamp.hidden = true;
      cover.classList.remove('has-cover');
      cover.style.backgroundImage = '';
      return;
    }
    const s = d.song || {};
    songEl.textContent = `${s.name || '未命名'}${s.artist ? '  /  ' + s.artist : ''}  ·  ${d.reason || ''}`;
    songEl.title = songEl.textContent;
    lineEl.textContent = d.line || '';
    dateEl.textContent = d.day || '今天';
    if (btn) btn.textContent = d.heard ? '↻ 再听一次' : '▶ 播放今日';
    if (stamp) { stamp.hidden = !d.heard; stamp.textContent = `已听 ${String(d.day || '').slice(5) || ''}`; }
    const cv = s.cover ? EW().coverUrl(s.cover) : '';
    if (cv) {
      cover.classList.add('has-cover');
      cover.style.backgroundImage = `url("${cv}")`;
    } else {
      cover.classList.remove('has-cover');
      cover.style.backgroundImage = '';
    }
  }

  function playDaily() {
    const d = state.daily;
    if (!d || d.empty) {
      const b = $('daily-play');
      if (b) b.click();
      else EW().go('page-search');
      return;
    }
    EW().play([Object.assign({}, d.song, { ewSource: '今日一曲' })], 0);
    toast('今日一曲 · 已开始播放');
    // 播放事件上报后刷新盖章，不用另存状态
    setTimeout(() => { if (window.Taste && Taste.flush) Taste.flush(true); }, 600);
    setTimeout(() => loadDaily(true), 2200);
  }

  /* 「给我一首意外的」搬到白天：与深夜页共用同一个反画像抽曲接口 */
  async function surprise() {
    const btn = $('v2-daily-surprise');
    if (btn) { btn.disabled = true; btn.textContent = '正在抽……'; }
    try {
      const r = await api('/api/taste/surprise', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ syncKey: key() }),
      });
      if (!r || !r.ok || !r.song) throw new Error((r && r.error) || '没抽到');
      EW().play([Object.assign({}, r.song, { ewSource: '意外的一首' })], 0);
      toast(r.reason || '给你一首意外的');
      api('/api/crate/mark', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ what: 'odd' }),
      }).catch(() => { });
    } catch (e) {
      toast(`抽不到：${e && e.message ? e.message : '服务不可用'}`, true);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '✦ 给我一首意外的'; }
    }
  }

  /* ================= ② 30 天热度条 / 去年今天 ================= */

  async function loadHeat() {
    const grid = $('v2-heat-grid');
    if (!grid) return;
    try {
      grid.classList.add('is-loading');
      const d = await api(`/api/taste/heat?syncKey=${kq()}&days=30`);
      state.heat = d;
      renderHeat();
    } catch {
      grid.classList.remove('is-loading');
      grid.innerHTML = '';
      const foot = $('v2-heat-foot');
      if (foot) foot.textContent = '热度条暂时取不到 · 刷新页面或稍后再试';
    }
  }

  function renderHeat() {
    const grid = $('v2-heat-grid');
    const foot = $('v2-heat-foot');
    if (!grid) return;
    const d = state.heat;
    if (!d) { grid.innerHTML = ''; return; }
    grid.classList.remove('is-loading');
    grid.innerHTML = (d.list || []).map((x) => {
      const label = `${x.day} · ${x.count ? x.count + ' 首' : '没听'}`;
      return `<button class="v2-heat-cell lv${x.level}${x.isToday ? ' is-today' : ''}" type="button" data-day="${esc(x.day)}" title="${esc(label)}" aria-label="${esc(label)}"></button>`;
    }).join('');
    if (foot) {
      foot.textContent = d.total
        ? `最近 30 天共 ${d.total} 次播放 · 点方块跳到那天的墙 · 记录保留一年`
        : '这 30 天还是白的 · 去听第一首，明天就亮一格';
    }
  }

  async function loadLastYear() {
    const card = $('home-ly-card');
    if (!card) return;
    try {
      const d = await api(`/api/taste/lastyear?syncKey=${kq()}`);
      state.lastyear = d;
      renderLastYear();
    } catch {
      state.lastyear = null;
      renderLastYear('error');
    }
  }

  function renderLastYear(reason) {
    const card = $('home-ly-card');
    if (!card) return;
    const d = state.lastyear;
    const empty = !d || d.empty;
    // 第三列常驻：回看行是固定三列，隐藏这张卡会留一整列空白。
    // 没数据 / 取不到数据时显示引导或错误状态，都有文字和动作，不是空占位。
    const set = (id, hide) => { const el = $(id); if (el) el.hidden = hide; };
    card.classList.toggle('is-empty', empty);
    set('hly-empty', !empty);
    set('hly-covers', empty);
    set('hly-line', empty);
    set('hly-tracks', empty);
    set('hly-replay', empty);
    if ($('hly-date')) $('hly-date').textContent = empty ? '' : (d.label || '');

    if (empty) {
      if ($('hly-empty-line')) $('hly-empty-line').textContent =
        reason === 'error' ? '本机记录暂时读不出来' : '去年今天还没有记录';
      if ($('hly-empty-sub')) $('hly-empty-sub').textContent = reason === 'error'
        ? '刷新页面或稍后再试，已经记下的不会丢。'
        : '从今天开始攒，明年这里会挂上一张唱片。';
      if ($('hly-note')) $('hly-note').textContent = '从今天开始记录 · 明年再回来看';
      const box = $('hly-covers');
      if (box) box.innerHTML = '';
      const tracks = $('hly-tracks');
      if (tracks) tracks.innerHTML = '';
      return;
    }
    if ($('hly-note')) $('hly-note').textContent = '只读本机记录 · 不出网';
    $('hly-line').textContent = d.line || '';
    const all = d.covers || [];
    // 封面固定四枚一行，多出来的曲目在下方列表里列出，不会出现半行空位
    const box = $('hly-covers');
    box.innerHTML = all.slice(0, 4).map((c) => {
      const cv = c.cover ? EW().coverUrl(c.cover) : '';
      return `<div class="hly-cover" title="${esc(c.name)}${c.artist ? ' — ' + esc(c.artist) : ''}"${cv ? ` style="background-image:url('${cv}')"` : ''}></div>`;
    }).join('');
    const tracks = $('hly-tracks');
    if (tracks) tracks.innerHTML = all.slice(0, 4).map((c, i) =>
      `<div class="hly-track"><span>${String(i + 1).padStart(2, '0')}</span>` +
      `<b title="${esc(c.name)}">${esc(c.name || '未命名')}</b>` +
      `<i title="${esc(c.artist || '')}">${esc(c.artist || '')}</i></div>`).join('');
  }

  /* 空态卡的动作：与左栏「听今日推荐」同一条路径，不给回看卡塞新的播放逻辑 */
  function goListen() {
    const b = $('daily-play');
    if (b) { b.click(); return; }
    EW().go('page-search');
  }

  /* ================= ④ 成就解锁：即时反馈 ================= */

  function chime() {
    try {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return;
      const ctx = new C();
      [523.25, 659.25, 783.99].forEach((f, i) => {
        const t = ctx.currentTime + i * 0.09;
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'square'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.05, t + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
        o.connect(g); g.connect(ctx.destination);
        o.start(t); o.stop(t + 0.14);
      });
      setTimeout(() => { try { ctx.close(); } catch { } }, 800);
    } catch { /* 静音环境不打扰 */ }
  }

  async function pollCrate() {
    try {
      const d = await api(`/api/crate/status?syncKey=${kq()}`);
      if (!d || typeof d.count !== 'number') return;
      const ids = (d.records || []).filter((r) => r.unlocked).map((r) => String(r.id || r.title)).join('|');
      if (state.crateCount != null && d.count > state.crateCount) {
        const before = new Set((state.crateIds || '').split('|'));
        const fresh = (d.records || []).find((r) => r.unlocked && !before.has(String(r.id || r.title)));
        chime();
        if (EW().flashTray) EW().flashTray(900);
        toast(`唱片店 +1  /  解锁「${fresh ? fresh.title : '新的一张'}」`);
        document.dispatchEvent(new CustomEvent('ew:crate-unlock', { detail: d }));
      }
      state.crateCount = d.count;
      state.crateIds = ids;
    } catch { /* 抽屉状态取不到就下次再看 */ }
  }

  /* ================= ④ 深夜频道：主动权交回用户 ================= */

  const LS_AUTO = 'ew_night_auto';
  const autoOn = () => { try { return localStorage.getItem(LS_AUTO) !== '0'; } catch { return true; } };
  function todayKey() { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }

  function setNight(on) {
    try {
      localStorage.setItem('ew_night_force', on ? 'on' : 'off');
      if (!on) localStorage.setItem('ew_night_optout', todayKey());
    } catch { /* 私密模式 */ }
    if (window.Night && Night.applyTheme) Night.applyTheme();
    syncNightUI();
    // 手动切入时上方已有可撤销提示条，不再叠一条 toast；退出才说一句
    if (!on) toast('已退出深夜频道');
  }

  function showUndo(msg) {
    const box = $('v2-undo');
    if (!box) return;
    $('v2-undo-msg').textContent = msg;
    box.hidden = false;
    clearTimeout(state.undo);
    state.undo = setTimeout(() => { box.hidden = true; }, 6000);
  }
  function hideUndo() { const b = $('v2-undo'); if (b) b.hidden = true; clearTimeout(state.undo); }

  function syncNightUI() {
    const auto = $('v2-night-auto');
    if (auto) auto.checked = autoOn();
    const t = $('v2-night-toggle');
    if (t) t.textContent = window.Night && Night.isActive && Night.isActive() ? '现在退出深夜' : '现在就切到深夜';
  }

  /* ================= ④ ⌘K 像素终端命令面板 ================= */

  function baseCommands() {
    return [
      { t: '播放今日一曲', g: '▶', k: '↵', run: playDaily },
      { t: '给我一首意外的（白天也能用）', g: '✦', run: surprise },
      { t: '重播今天的墙 → 加入队列', g: '↻', run: () => replayDay('', '今天', true) },
      { t: '把这一期做成歌单 → 加入队列', g: '≡', run: () => replayPeriod() },
      { t: '再听去年今天 → 加入队列', g: '◷', run: replayLastYear },
      { t: '打开唱片墙', g: '▦', run: () => EW().go('page-wall') },
      { t: '打开听觉年鉴', g: '▤', run: () => EW().go('page-yearbook') },
      { t: '打开隐藏唱片店', g: '◈', run: () => { if (window.Crate && Crate.openPage) Crate.openPage(); else EW().go('page-crate'); } },
      { t: '打开深夜频道', g: '☾', run: () => { if (window.Night && Night.openPage) Night.openPage(); else EW().go('page-midnight'); } },
      { t: '切到 / 退出深夜配色', g: '◐', run: () => setNight(!(window.Night && Night.isActive && Night.isActive())) },
      { t: '回到首页', g: '⌂', k: '⌘1', run: () => EW().go('page-discover') },
      { t: '打开曲库', g: '▣', run: () => EW().go('page-mine') },
      { t: '播放 / 暂停', g: '❚❚', k: 'Space', run: () => { const t = $('toggle'); if (t) t.click(); } },
    ];
  }

  function cmdOpen() {
    const mask = $('v2-cmd-mask');
    if (!mask) return;
    mask.hidden = false;
    state.cmdOpen = true;
    const input = $('v2-cmd-input');
    input.value = '';
    renderCmd(baseCommands(), '');
    setTimeout(() => input.focus(), 0);
  }
  function cmdClose() {
    const mask = $('v2-cmd-mask');
    if (mask) mask.hidden = true;
    state.cmdOpen = false;
    state.cmdSeq += 1;
    clearTimeout(state.cmdTimer);
  }

  function renderCmd(items, query, pending) {
    state.cmdItems = items;
    state.cmdIndex = 0;
    const box = $('v2-cmd-list');
    if (!box) return;
    if (!items.length && !pending) {
      box.innerHTML = `<div class="v2-cmd-empty">${query ? '没找到「' + esc(query) + '」· 换个词试试' : '没有可用命令'}</div>`;
      return;
    }
    box.innerHTML = items.map((it, i) => `<button class="v2-cmd-row${i === 0 ? ' is-on' : ''}" data-i="${i}" type="button">
      <span class="v2-cmd-glyph">${esc(it.g || '·')}</span><span>${esc(it.t)}</span>
      <span class="v2-cmd-key">${esc(it.k || '')}</span></button>`).join('')
      + (pending ? `<div class="v2-cmd-empty">${esc(pending)}</div>` : '');
    box.querySelectorAll('.v2-cmd-row').forEach((el) => {
      el.addEventListener('click', () => {
        const i = Number(el.dataset.i);
        state.cmdIndex = i;
        cmdRun();
      });
      el.addEventListener('mouseenter', () => {
        state.cmdIndex = Number(el.dataset.i);
        box.querySelectorAll('.v2-cmd-row').forEach((x, j) => x.classList.toggle('is-on', j === state.cmdIndex));
      });
    });
  }

  function cmdMove(delta) {
    if (!state.cmdItems.length) return;
    state.cmdIndex = (state.cmdIndex + delta + state.cmdItems.length) % state.cmdItems.length;
    const box = $('v2-cmd-list');
    if (!box) return;
    box.querySelectorAll('.v2-cmd-row').forEach((x, j) => x.classList.toggle('is-on', j === state.cmdIndex));
    const on = box.querySelector('.v2-cmd-row.is-on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
  }

  function cmdRun() {
    const it = state.cmdItems[state.cmdIndex];
    if (!it) return;
    cmdClose();
    try { it.run(); } catch (e) { toast(`执行失败：${e && e.message ? e.message : '未知错误'}`, true); }
  }

  function cmdInput(q) {
    const query = String(q || '').trim();
    const seq = ++state.cmdSeq;
    clearTimeout(state.cmdTimer);
    if (!query) { renderCmd(baseCommands(), ''); return; }
    const hit = baseCommands().filter((c) => c.t.toLowerCase().includes(query.toLowerCase()));
    // 状态可见：多平台检索可能要几秒，先明说「正在搜歌」，不留一个假的空结果
    renderCmd(hit, query, '正在搜歌…');
    // 输入即搜歌：命令之外的部分交给统一音源，结果同样可回车直接播
    state.cmdTimer = setTimeout(async () => {
      try {
        const r = await api(`/api/unified/search?keywords=${encodeURIComponent(query)}&limit=6`);
        if (seq !== state.cmdSeq || !state.cmdOpen) return;
        const songs = (r && r.songs) || [];
        const extra = songs.slice(0, 6).map((s) => ({
          t: `${s.name}${s.artist ? '  /  ' + s.artist : ''}`,
          g: '♪', k: '搜歌',
          run: () => EW().play([s], 0),
        }));
        renderCmd([...hit, ...extra], query, extra.length ? '' : '没搜到这首歌');
      } catch {
        if (seq !== state.cmdSeq) return;
        renderCmd(hit, query, '搜歌暂时不可用 · 命令仍可执行');
      }
    }, 260);
  }

  /* ================= 刷新与绑定 ================= */

  async function refreshAll(force) {
    if (state.loading) return;
    state.loading = true;
    await Promise.all([
      loadDaily(!!force), loadHeat(), loadLastYear(), pollCrate(),
    ]);
    state.lastAt = Date.now();
    state.loading = false;
  }

  function bindRewind() {
    // 卡片自身是 role=button（点整卡跳页），内部动作要停掉冒泡
    const bind = (id, fn) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); fn(); } });
    };
    bind('hw-replay', () => replayDay('', '今天', true));
    bind('hy-replay', () => replayPeriod('month'));
    bind('hly-replay', replayLastYear);
    bind('hly-empty-go', goListen);
    bind('wall-replay', () => replayDay('', '这一天'));
    bind('yb-replay', () => replayPeriod());
    bind('v2-daily-play', playDaily);
    bind('v2-daily-surprise', surprise);

    const grid = $('v2-heat-grid');
    if (grid) grid.addEventListener('click', (e) => {
      const cell = e.target && e.target.closest && e.target.closest('.v2-heat-cell');
      if (!cell) return;
      const day = cell.dataset.day;
      if (window.Wall && Wall.gotoDay) Wall.gotoDay(day);
      else EW().go('page-wall');
    });
  }

  function bindNight() {
    const auto = $('v2-night-auto');
    if (auto) auto.addEventListener('change', () => {
      try {
        if (auto.checked) {
          localStorage.setItem(LS_AUTO, '1');
          localStorage.removeItem('ew_night_force');
          if (window.Night && Night.applyTheme) Night.applyTheme();
          toast('深夜频道已恢复自动接管（0–5 点）');
        } else {
          localStorage.setItem(LS_AUTO, '0');
          setNight(false);
        }
      } catch { /* 私密模式 */ }
      syncNightUI();
    });
    const t = $('v2-night-toggle');
    if (t) t.addEventListener('click', () => {
      const on = !(window.Night && Night.isActive && Night.isActive());
      setNight(on);
      if (on) showUndo('已手动切到深夜配色 · 可撤销');
      else hideUndo();
    });
    const undo = $('v2-undo-btn');
    if (undo) undo.addEventListener('click', () => { setNight(false); hideUndo(); });

    // 自动接管从关到开时，给一次可撤销的提示（工具型应用不该悄悄改界面）
    setInterval(() => {
      const on = document.body.classList.contains('midnight');
      if (state.midnightWas === null) { state.midnightWas = on; return; }
      if (on && !state.midnightWas && autoOn()) {
        let forced = '';
        try { forced = localStorage.getItem('ew_night_force') || ''; } catch { }
        if (!forced) showUndo('已按时间切到深夜配色 · 可撤销');
      }
      state.midnightWas = on;
      syncNightUI();
    }, 30000);
    syncNightUI();
  }

  function bindCmd() {
    const input = $('v2-cmd-input');
    if (input) input.addEventListener('input', (e) => cmdInput(e.target.value));
    const mask = $('v2-cmd-mask');
    if (mask) mask.addEventListener('click', (e) => { if (e.target === mask) cmdClose(); });

    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault(); e.stopPropagation();
        state.cmdOpen ? cmdClose() : cmdOpen();
        return;
      }
      if (!state.cmdOpen) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cmdClose(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); cmdMove(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); cmdMove(-1); return; }
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); cmdRun(); }
    }, true);
  }

  function bind() {
    bindRewind();
    bindNight();
    bindCmd();

    document.addEventListener('ew:page', (e) => {
      if (e.detail === 'page-discover') refreshAll(false);
      if (e.detail === 'page-midnight') syncNightUI();
    });
    // 成就解锁后左栏进度立刻跟上
    document.addEventListener('ew:crate-unlock', () => {
      if (window.Crate && Crate.load) Crate.load(true);
      if (window.HomeExtra && HomeExtra.refresh) HomeExtra.refresh();
    });

    refreshAll(false);
    // 同步码可能是 bootstrap 之后才拿到的，补一次静默刷新
    setTimeout(() => refreshAll(true), 2200);
    // 首页可见时每分钟轻轻刷一次（盖章、热度、解锁）
    setInterval(() => {
      const home = $('page-discover');
      if (!home || home.hidden || document.visibilityState !== 'visible') return;
      refreshAll(true);
    }, 60000);
  }

  window.Rewind = {
    replayDay, replayPeriod, replayLastYear, surprise, playDaily,
    refresh: () => refreshAll(true),
    debug: () => ({
      daily: state.daily && (state.daily.empty ? 'empty' : state.daily.song && state.daily.song.name),
      heat: state.heat && state.heat.total,
      lastyear: state.lastyear && (state.lastyear.empty ? 'empty' : state.lastyear.count),
      crate: state.crateCount,
    }),
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
})();
