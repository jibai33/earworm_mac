/* ====================================================================
   闻曲 · 隐藏唱片店（前端）
   ---------------------------------------------------------------
   · 抽屉里 8 张唱片，解锁状态由服务端按事实推导（/api/crate/status）
   · 解锁的那张能真的播：16 秒 8-bit 片段用 Web Audio 现场合成，
     旋律由 seed 决定，同一张唱片每次听起来都一样
   · 路由到 app.js 的 analyser，所以放唱片时菜单栏频谱也会动
   ==================================================================== */
(function () {
  const $ = (id) => document.getElementById(id);
  const state = { data: null, loading: false, playing: null, timer: null };

  /* ---------- 8-bit 合成 ---------- */
  const ROOT = { C: 261.63, D: 293.66, E: 329.63, F: 349.23, G: 392, A: 440, B: 493.88 };
  const DEGREES = [0, 2, 4, 7, 9, 12, 14, 16];
  const BPM = 112;
  const STEP = 60 / BPM / 4;          // 十六分音符
  const BARS = 8;
  const STEPS = BARS * 16;

  let ctx = null, master = null, noiseBuf = null, sources = [];
  let ownCtx = null;

  function rng(seed) {
    let a = seed >>> 0 || 1;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function ensureCtx() {
    if (ctx) return ctx;
    const shared = window.EW && window.EW.audio ? window.EW.audio() : null;
    if (shared && shared.ctx) {
      ctx = shared.ctx;
      master = ctx.createGain();
      master.gain.value = 0;
      master.connect(shared.analyser || ctx.destination);
    } else {
      ownCtx = new (window.AudioContext || window.webkitAudioContext)();
      ctx = ownCtx;
      master = ctx.createGain();
      master.gain.value = 0;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * .12), ctx.sampleRate);
    const ch = noiseBuf.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
    return ctx;
  }

  function note(freq, at, dur, gain, type) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type || 'square';
    osc.frequency.setValueAtTime(freq, at);
    // 方波不加滤波会太扎，用一个短包络压住尾巴
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(gain, at + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(g).connect(master);
    osc.start(at);
    osc.stop(at + dur + 0.02);
    sources.push(osc);
  }

  function hat(at, gain) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 5200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
    src.connect(hp).connect(g).connect(master);
    src.start(at);
    src.stop(at + 0.06);
    sources.push(src);
  }

  function stopRecord() {
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    if (master && ctx) {
      const t = ctx.currentTime;
      master.gain.cancelScheduledValues(t);
      master.gain.setValueAtTime(master.gain.value, t);
      master.gain.linearRampToValueAtTime(0, t + 0.08);
    }
    const list = sources;
    sources = [];
    setTimeout(() => {
      list.forEach((n) => { try { n.stop(); } catch { /* 已经停了 */ } });
    }, 120);
    state.playing = null;
    window.__ewExternalAudio = false;
    renderSlots();
  }

  function playRecord(rec) {
    ensureCtx();
    sources.forEach((n) => { try { n.stop(); } catch { /* ignore */ } });
    sources = [];
    const t0 = ctx.currentTime + 0.06;
    master.gain.cancelScheduledValues(t0);
    master.gain.setValueAtTime(0, t0);
    master.gain.linearRampToValueAtTime(0.13, t0 + 0.12);

    const rand = rng(rec.seed * 7919 + 13);
    const root = ROOT[rec.key] || ROOT.C;
    const beat = STEP * 4;

    for (let bar = 0; bar < BARS; bar++) {
      const barAt = t0 + bar * beat * 4;
      // 低音：每小节两下，根音 / 五度交替
      note(root / 2, barAt, STEP * 3.4, 0.16, 'triangle');
      note(root / 2 * (bar % 2 ? 1.5 : 1), barAt + beat * 2, STEP * 3.4, 0.14, 'triangle');
      // 主旋律：八分音符，三成休止，五声音阶里跳
      for (let s = 0; s < 8; s++) {
        if (rand() < 0.3) continue;
        const deg = DEGREES[Math.floor(rand() * DEGREES.length)];
        const freq = root * Math.pow(2, deg / 12);
        const dur = rand() < 0.18 ? STEP * 1.6 : STEP * .9;
        note(freq, barAt + s * beat / 2, dur, 0.075 + rand() * 0.03, 'square');
      }
      // 打点：反拍轻噪声
      for (let s = 1; s < 8; s += 2) hat(barAt + s * beat / 2, 0.035);
    }

    state.playing = rec.id;
    window.__ewExternalAudio = true;
    renderSlots();
    const total = (BARS * 4 * beat + 0.6) * 1000;
    state.timer = setTimeout(() => stopRecord(), total);
  }

  function toggleRecord(rec) {
    if (state.playing === rec.id) { stopRecord(); return; }
    // 放唱片片段时把主播放器停下，避免两条声音打架
    const audio = $('audio');
    if (audio && !audio.paused) audio.pause();
    playRecord(rec);
  }

  /* ---------- 渲染 ---------- */
  function esc(s) { return String(s || '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }
  const LABELS = ['#e6b06a', '#8fb8ae', '#d1483a', '#5f83b0', '#c9a227', '#a98ac9', '#6fae8f', '#d98a6a'];

  function renderSlots() {
    const box = $('crate-slots');
    if (!box || !state.data) return;
    box.innerHTML = '';
    state.data.records.forEach((rec, i) => {
      const el = document.createElement('div');
      el.className = 'slot ' + (rec.unlocked ? 'on' : 'locked') + (state.playing === rec.id ? ' playing' : '');
      const label = LABELS[i % LABELS.length];
      // 锁着的格：一半是锁，一半是问号——留出「这里还差一张」的悬念，不全是同一种空
      const lockedGlyph = i % 2 === 0
        ? `<svg viewBox="0 0 12 15" class="lock" aria-hidden="true"><g fill="#3a4757"><rect x="3" y="1" width="1" height="4"/><rect x="8" y="1" width="1" height="4"/><rect x="3" y="1" width="6" height="1"/></g><g fill="#4d5a6d"><rect x="1" y="5" width="10" height="9"/><rect x="2" y="4" width="8" height="1"/></g><g fill="#0b0e12"><rect x="5" y="8" width="2" height="3"/></g></svg>`
        : `<span class="q">? ? ?</span>`;
      el.innerHTML = `
        <div class="sleeve">
          ${rec.unlocked
            ? `<div class="disc" style="--label:${label}"></div><span class="sname">${esc(rec.title)}</span>`
            : lockedGlyph}
        </div>
        <div class="tagline"><span>${rec.unlocked ? rec.side : '暗号未解'}</span><span>${rec.unlocked ? (state.playing === rec.id ? '播放中' : rec.kind) : '#' + String(i + 1).padStart(2, '0')}</span></div>`;
      el.addEventListener('click', () => {
        if (rec.unlocked) toggleRecord(rec);
        else showTip(rec);
      });
      box.appendChild(el);
    });
  }

  function showTip(rec) {
    const tip = $('crate-tip');
    if (!tip) return;
    tip.innerHTML = `<span>这 张 还 锁 着</span>${esc(rec.hint)}<br><i style="font-style:normal;color:var(--px-dim)">条件：${esc(rec.how)}</i>`;
  }

  function renderAside() {
    const log = $('crate-log');
    const tip = $('crate-tip');
    if (!state.data) return;
    const unlocked = state.data.records.filter((r) => r.unlocked).sort((a, b) => a.at - b.at);
    if (log) {
      log.innerHTML = unlocked.length
        ? unlocked.map((r) => {
          const d = new Date(r.at);
          return `<div class="cl-line on"><i>${d.getMonth() + 1}.${String(d.getDate()).padStart(2, '0')}</i>${esc(r.title)}</div>`;
        }).join('')
        : '<div class="cl-line">还没有唱片，先从登录彩蛋开始。</div>';
    }
    if (tip && state.data.next) {
      tip.innerHTML = `<span>下 一 张 线 索</span>${esc(state.data.next.hint)}<br><i style="font-style:normal;color:var(--px-dim)">条件：${esc(state.data.next.how)}</i>`;
    } else if (tip) {
      tip.innerHTML = '<span>抽 屉 已 满</span>八张都在了。等下一版再往深处挖。';
    }
    const bar = $('crate-bar');
    if (bar) {
      bar.innerHTML = state.data.records.map((r) => `<i class="${r.unlocked ? 'on' : ''}"></i>`).join('');
    }
    const label = $('crate-progress-label');
    if (label) label.textContent = `${state.data.count} / ${state.data.total}`;
    const kicker = $('crate-count-label');
    if (kicker) kicker.textContent = `${state.data.count} / ${state.data.total} 张`;
    const nextHint = $('crate-next-hint');
    if (nextHint) nextHint.textContent = state.data.next ? `再解 1 张解锁「${state.data.next.title}」` : '抽屉已满';
  }

  function updateEntry() {
    const el = $('crate-entry-count');
    if (el && state.data) el.textContent = `${state.data.count} / ${state.data.total}`;
  }

  async function load(force) {
    if (state.loading) return;
    if (!force && state.data) { renderSlots(); renderAside(); updateEntry(); return; }
    state.loading = true;
    try {
      const key = (window.Taste && Taste.getSyncKey && Taste.getSyncKey()) || '';
      const r = await window.EW.api(`/api/crate/status?syncKey=${encodeURIComponent(key)}`);
      state.data = r;
      renderSlots();
      renderAside();
      updateEntry();
    } catch (e) {
      const box = $('crate-slots');
      if (box) box.innerHTML = `<div class="crate-foot">抽屉打不开：${esc(e.message)}</div>`;
    } finally {
      state.loading = false;
    }
  }

  function openPage() {
    window.EW.go('page-crate');
    load(true);
  }

  /* ---------- 绑定 ---------- */
  function bind() {
    const entry = $('crate-entry');
    if (entry) entry.addEventListener('click', openPage);
    document.addEventListener('ew:page', (e) => {
      if (e.detail === 'page-crate') load(true);
      if (e.detail !== 'page-crate' && state.playing) stopRecord();
    });
    load(false);
  }

  window.Crate = {
    openPage, load, debug: () => ({ count: state.data && state.data.count, playing: state.playing }),
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
})();
