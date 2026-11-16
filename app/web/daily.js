/* ====================================================================
   闻曲 · 每日登录彩蛋（前端）
   ------------------------------------------------------------------
   和登录彩蛋（egg.js，输暗号 + 四幕全屏演出）分工不同：
   这一张是每天第一次打开闻曲时掉出来的「今日签」，不占屏幕、不用暗号。

   三点取舍：
   1) 打开即签到：卡片一露头就静默 claim，之后关掉、刷新都不会重复弹。
      不做「必须点收下才算」——忘了点就断签，那是在惩罚人。
   2) 文案全部来自服务端按日期稳定生成，同一台机器同一天永远是同一张签。
   3) 今日动作都是真能执行的功能入口，不是装饰。
   ==================================================================== */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

  const LS_SEEN = 'ew_daily_seen';
  const LS_OFF = 'ew_daily_off';      // 「以后都别弹」：一个开关，不逼人每天关

  const state = {
    data: null, act: null, shown: false, front: true, claimed: false, brokenLock: false,
    timer: 0, idleTimer: 0, bootAt: 0, pending: false,
  };

  function api(p, opts) {
    if (window.EW && window.EW.api) return window.EW.api(p, opts);
    return fetch(p, opts).then((r) => r.json());
  }
  function toast(msg, warn) { if (window.EW && window.EW.toast) window.EW.toast(msg, warn); }
  function ls(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } }
  function setls(k, v) { try { localStorage.setItem(k, v); } catch { /* 私密模式 */ } }
  function todayStr() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /* ---------- 渲染 ---------- */
  function render(d) {
    state.data = d;
    const card = $('ds-card');
    if (!card) return;

    $('ds-no').textContent = 'NO.' + String(d.no || 1).padStart(4, '0');
    $('ds-date').textContent = String(d.today || '').replace(/-/g, '.');
    $('ds-line').textContent = d.line ? d.line.t : '';
    $('ds-sub').textContent = d.line ? d.line.s : '';

    const streak = Number(d.streak || 1);
    // claim 之后服务端把 broken 清掉了，但要如实告诉人「今天是从断签重来的」。
    // 一旦这次展示确认过是断签，就不再被后续刷新覆盖回去。
    if (d.wasBroken || d.broken) state.brokenLock = true;
    const broken = state.brokenLock === true;
    const st = $('ds-streak');
    st.textContent = broken && streak === 1 ? '断了 · 今天第 1 天' : streak === 1 ? '第 1 天' : `连续 ${streak} 天`;
    st.classList.toggle('is-broken', broken && streak === 1);

    $('ds-tone').textContent = d.tone ? d.tone.name : '';
    $('ds-tone').title = d.tone ? d.tone.note : '';
    $('ds-bpm').textContent = d.bpm ? d.bpm + ' BPM' : '';

    /* 背面 */
    // 「给这首歌留句话」得有歌在放才成立；没有就换一件现在就能做的事，
    // 不给一个点了会说「先放首歌再来」的按钮
    let act = d.action || {};
    if (act.id === 'comments' && !(window.EW && window.EW.current && window.EW.current())) {
      act = { id: 'surprise', t: '给我一首意外的', hint: '今天这条要等有歌在放；先从这一首开始' };
    }
    state.act = act;
    $('ds-act-title').textContent = act.t || '';
    $('ds-act-hint').textContent = act.hint || '';

    const next = d.next;
    if (next) {
      const left = Math.max(0, Number(d.left || 0));
      $('ds-prog-label').textContent = left === 0 ? '就是今天' : `距第 ${next} 天还差 ${left} 天`;
      $('ds-prog-fill').style.width = Math.max(4, Math.min(100, Math.round((streak / next) * 100))) + '%';
    } else {
      $('ds-prog-label').textContent = '已经走过一年';
      $('ds-prog-fill').style.width = '100%';
    }
    $('ds-total').textContent = String(d.total || 0);
    $('ds-best').textContent = String(d.best || streak);

    /* 里程碑 */
    const mile = Number(d.milestone || 0);
    card.classList.toggle('is-milestone', mile > 0);
    card.classList.toggle('is-broken', broken && streak === 1);
    const seal = $('ds-seal');
    seal.hidden = !mile;
    if (mile) seal.textContent = `SEAL ${mile}`;
    const btnSeal = $('ds-seal-show');
    btnSeal.hidden = !mile;
    if (mile) btnSeal.textContent = `拆封第 ${mile} 天 →`;

    $('ds-take').textContent = mile ? '知道了' : '收下';
    setFront(true);
  }

  function setFront(on) {
    state.front = on;
    const front = $('ds-front'), back = $('ds-back');
    if (!front || !back) return;
    front.hidden = !on;
    back.hidden = on;
    $('ds-flip').textContent = on ? '翻面 ↻' : '回到正面 ↺';
  }

  /* ---------- 开 / 关 ---------- */
  function show(force) {
    const box = $('ds-box');
    if (!box || state.shown) return;
    if (!state.data) return;
    if (!force) {
      if (ls(LS_OFF) === '1') return;
      if (ls(LS_SEEN) === todayStr()) return;
    }
    state.shown = true;
    setls(LS_SEEN, todayStr());
    box.hidden = false;
    // 撞上「已切到深夜配色 · 可撤销」那条提示时让开
    const undo = $('v2-undo');
    box.classList.toggle('is-lifted', !!(undo && !undo.hidden));
    // 用定时器而不是 rAF：窗口在后台时 rAF 会被挂起，卡片会卡在透明状态
    setTimeout(() => { if (state.shown) box.classList.add('is-in'); }, 20);
    claimOnce();
    armIdle();
    if (!force) {
      // 只读屏的人也能知道有这么一张卡，但不抢焦点
      $('ds-card').setAttribute('aria-label', '今日签：' + (state.data.line ? state.data.line.t : ''));
    }
  }

  function hide() {
    const box = $('ds-box');
    if (!box || !state.shown) return;
    state.shown = false;
    box.classList.remove('is-in', 'is-idle', 'is-lifted');
    box.classList.add('is-out');
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      box.hidden = true;
      box.classList.remove('is-out');
    }, 240);
  }

  function armIdle() {
    clearTimeout(state.idleTimer);
    const box = $('ds-box');
    if (!box) return;
    box.classList.remove('is-idle');
    if (state.shown) state.idleTimer = setTimeout(() => { if (state.shown) box.classList.add('is-idle'); }, 10000);
  }

  async function claimOnce() {
    if (state.claimed) return;
    state.claimed = true;
    for (let i = 0; i < 2; i++) {
      try {
        const r = await api('/api/daily/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        if (r && r.ok) { render(r); return; }
      } catch { /* 再试一次就放弃，不打扰听歌 */ }
    }
  }

  /* ---------- 今日动作 ---------- */
  function runAction(id) {
    const R = window.Rewind || {};
    const C = window.Crate || {};
    const N = window.Night || {};
    switch (id) {
      case 'surprise': R.surprise && R.surprise(); break;
      case 'lastyear': R.replayLastYear && R.replayLastYear(); break;
      case 'today-wall': R.replayDay && R.replayDay('', '今天', true); break;
      case 'daily-song': R.playDaily && R.playDaily(); break;
      case 'crate': (C.openPage || (() => window.EW.go('page-crate')))(); break;
      case 'yearbook': window.EW.go('page-yearbook'); break;
      case 'midnight': (N.openPage || (() => window.EW.go('page-midnight')))(); break;
      case 'comments': window.EW.comments && window.EW.comments(); break;
      default: break;
    }
    hide();
  }

  /* ---------- 里程碑短演出 ---------- */
  function playSeal() {
    const d = state.data || {};
    if (!window.Egg || !Egg.playScene) { hide(); toast('今天这份先记着'); return; }
    const day = d.milestone || d.streak || 1;
    hide();
    Egg.playScene({
      kind: 'daily',
      title: `第 ${day} 天`,
      sceneTitle: `第 ${day} 天 · 位置一直在`,
      sceneLine: '明天这个位置还是你的。',
      badge: 'DAILY SEAL',
    });
  }

  /* ---------- 启动 ---------- */
  function bootDone() {
    return document.documentElement.classList.contains('boot-done') || !$('boot');
  }
  function eggBusy() {
    const m = $('egg-modal');
    return !!(m && !m.hidden);
  }

  async function boot() {
    if (ls(LS_OFF) === '1') return;
    let d;
    try { d = await api('/api/daily/status'); } catch { return; }
    if (!d || !d.ok) return;
    render(d);
    if (!d.isNew) {
      // 今天已经收过了：留一个小小的入口，不主动弹
      return;
    }
    // 等开机动画退场，再等一会儿，免得和首屏渲染抢注意力
    const wait = () => {
      if (!bootDone()) { setTimeout(wait, 260); return; }
      if (eggBusy()) { setTimeout(wait, 900); return; }
      show(false);
    };
    setTimeout(wait, 1400);
  }

  /* ---------- 绑定 ---------- */
  function bind() {
    const box = $('ds-box');
    if (!box) return;

    $('ds-close').addEventListener('click', hide);
    $('ds-take').addEventListener('click', hide);
    $('ds-flip').addEventListener('click', () => setFront(!state.front));
    $('ds-seal-show').addEventListener('click', playSeal);
    $('ds-act').addEventListener('click', () => runAction(state.act ? state.act.id : ''));

    box.addEventListener('pointerenter', () => { box.classList.remove('is-idle'); clearTimeout(state.idleTimer); });
    box.addEventListener('pointerleave', armIdle);

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !state.shown) return;
      // 别的浮层开着时，Esc 归它们
      const cmd = $('v2-cmd-mask');
      if (cmd && !cmd.hidden) return;
      if (eggBusy()) return;
      e.stopPropagation();
      hide();
    }, true);

    // 播放条出现 / 消失会改变底部占位，重新让位
    window.addEventListener('resize', () => {
      if (!state.shown) return;
      const undo = $('v2-undo');
      box.classList.toggle('is-lifted', !!(undo && !undo.hidden));
    });

    boot();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();

  window.DailySeal = {
    show: (force) => { if (state.data) show(!!force); },
    hide,
    /** 外部（⌘K / 测试）按 id 直接跑今日动作 */
    run: (id) => runAction(String(id || '')),
    open: async () => {   // ⌘K 用：今天收过了也强制看一眼
      if (!state.data) {
        try { const d = await api('/api/daily/status'); if (d && d.ok) render(d); } catch { return; }
      }
      show(true);
    },
    mute: (on) => setls(LS_OFF, on ? '1' : '0'),
    debug: () => ({
      shown: state.shown, front: state.front, claimed: state.claimed,
      today: state.data && state.data.today, streak: state.data && state.data.streak,
      no: state.data && state.data.no, milestone: state.data && state.data.milestone,
      act: state.act && state.act.id,
      isNew: state.data && state.data.isNew, muted: ls(LS_OFF) === '1',
    }),
  };
})();
