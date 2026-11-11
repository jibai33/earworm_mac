/* ====================================================================
   闻曲 · 像素唱片墙（前端）
   ---------------------------------------------------------------
   · 一天一面墙：当天听过的封面钉在当天的墙上，服务端按日期存，
     所以退出重进、甚至第二天回看，这一面墙都还在
   · 左右翻页看之前/之后某一天；只在这段时间真的听过歌的日子之间走
   · 悬停看曲名，点击直接播；空位是钉子，不是占位符
   ==================================================================== */
(function () {
  const $ = (id) => document.getElementById(id);
  const state = { data: null, loading: false, day: '' }; // day 为空 = 今天
  const esc = (s) => String(s || '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

  /** 'YYYY-MM-DD' 前后挪一天，返回同格式 */
  function shiftDay(key, delta) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || '');
    if (!m) return '';
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    d.setDate(d.getDate() + delta);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  async function load(force) {
    if (state.loading) return;
    if (!force && state.data) { render(); return; }
    state.loading = true;
    try {
      const key = (window.Taste && Taste.getSyncKey && Taste.getSyncKey()) || '';
      const day = state.day ? `&day=${encodeURIComponent(state.day)}` : '';
      const r = await window.EW.api(`/api/taste/wall?syncKey=${encodeURIComponent(key)}${day}`);
      state.data = r;
      render();
    } catch (e) {
      const grid = $('wall-grid');
      if (grid) grid.innerHTML = `<div class="wall-foot">墙面取不到：${esc(e.message)}</div>`;
    } finally {
      state.loading = false;
    }
  }

  function renderNav(d) {
    const label = $('wall-day');
    if (label) label.textContent = d.dayLabel || '今天';
    const prev = $('wall-prev'), next = $('wall-next'), today = $('wall-today');
    if (prev) { prev.disabled = !d.hasPrev; prev.title = d.hasPrev ? '前一天' : '再往前没有记录了'; }
    if (next) { next.disabled = !d.hasNext; next.title = d.hasNext ? '后一天' : '这是最近的一天'; }
    if (today) {
      // 已经在今天就不必留一个灰按钮占位置
      today.hidden = !!d.isToday;
      today.style.display = d.isToday ? 'none' : '';
    }
  }

  function render() {
    const d = state.data;
    if (!d) return;

    const meta = $('wall-meta');
    if (meta) {
      // 不报「刚听过几张」：满墙时全都刚听过，数字反而和 hung 打架，交给角标
      meta.textContent = `${d.hung} / ${d.capacity} 张`
        + (d.hasMore ? ` · 另有 ${d.total - d.capacity} 张在下一面墙` : '');
    }
    renderNav(d);

    const grid = $('wall-grid');
    if (!grid) return;
    grid.innerHTML = '';
    // 只铺到「够用」为止：4 张就画两行，不要把 20 个空钉子铺成一屏
    const CAP = d.capacity || 24;
    const need = Math.max(12, Math.ceil(Math.max(d.total, 1) / 6) * 6);
    const count = Math.min(CAP, d.hasMore ? CAP : need);
    d.slots.slice(0, count).forEach((item, i) => {
      const tile = document.createElement('div');
      if (!item) {
        tile.className = 'wall-tile empty';
        tile.title = '空位：钉子已经钉好了';
        grid.appendChild(tile);
        return;
      }
      // 只标「最近挂上去的那一张」：满墙时 24 个暖光会互相打架，
      // 新唱片挂在最前面这件事本身就说明位置了
      const isFresh = item.fresh && i === 0;
      tile.className = 'wall-tile' + (isFresh ? ' is-fresh' : '') + (item.cover ? '' : ' no-cover');
      tile.dataset.i = String(i);
      const cover = item.cover ? window.EW.coverUrl(item.cover) : '';
      tile.innerHTML = `${cover ? `<img src="${cover}" alt="">` : ''}
        <div class="wt-info">
          <div class="wt-name">${esc(item.name)}</div>
          <div class="wt-artist">${esc(item.artist)}</div>
        </div>`;
      tile.addEventListener('click', () => {
        const songs = d.slots.filter(Boolean).map((s) => ({
          id: s.id, provider: s.provider || 'netease', name: s.name,
          artist: s.artist, cover: s.cover,
        }));
        const idx = d.slots.filter(Boolean).indexOf(item);
        window.EW.play(songs, idx);
      });
      grid.appendChild(tile);
    });

    const foot = $('wall-foot');
    if (foot) {
      if (d.total === 0) {
        foot.innerHTML = d.isToday
          ? '今天墙上还空着。听一首歌，第一枚钉子就会挂上东西。'
          : '这一天没有听歌记录——墙是空的，钉子还在。';
      } else {
        foot.innerHTML = `${d.isToday ? '今天' : d.dayLabel}挂了 ${d.hung} 张 · 最近听的先上墙`
          + (d.hasMore ? ` · 另有 ${d.total - d.capacity} 张在下一面墙` : '');
      }
    }
    const entry = $('wall-entry-count');
    if (entry) entry.textContent = `${d.hung} / ${d.capacity}`;
  }

  function openPage() {
    window.EW.go('page-wall');
    load(true);
  }

  function bind() {
    const entry = $('wall-entry');
    if (entry) entry.addEventListener('click', openPage);

    // 翻页：按日历挪一天，再向服务端要那一天
    const go = (delta) => {
      const d = state.data;
      if (!d) return;
      if (delta < 0 && !d.hasPrev) return;
      if (delta > 0 && !d.hasNext) return;
      state.day = shiftDay(d.day, delta);
      load(true);
    };
    const prev = $('wall-prev'), next = $('wall-next'), today = $('wall-today');
    if (prev) prev.addEventListener('click', () => go(-1));
    if (next) next.addEventListener('click', () => go(1));
    if (today) today.addEventListener('click', () => {
      if (state.data && state.data.isToday) return;
      state.day = '';
      load(true);
    });

    document.addEventListener('ew:page', (e) => {
      if (e.detail !== 'page-wall') return;
      // 每次进来都回到今天：翻到上周只是浏览，不该记住
      state.day = '';
      load(true);
    });
    load(false);
  }

  window.Wall = {
    openPage, load,
    debug: () => ({ total: state.data && state.data.total, day: state.data && state.data.day }),
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
})();
