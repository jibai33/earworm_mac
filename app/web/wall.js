/* ====================================================================
   闻曲 · 像素唱片墙（前端）
   ---------------------------------------------------------------
   · 数据来自 /api/taste/wall（本机事件流聚合，最近先上墙）
   · 悬停看曲名，点击直接播；空位是钉子，不是占位符
   · 满 24 张会继续往下一面墙挂（服务端 hasMore 为真时说明还有）
   ==================================================================== */
(function () {
  const $ = (id) => document.getElementById(id);
  const state = { data: null, loading: false };
  const esc = (s) => String(s || '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

  async function load(force) {
    if (state.loading) return;
    if (!force && state.data) { render(); return; }
    state.loading = true;
    try {
      const key = (window.Taste && Taste.getSyncKey && Taste.getSyncKey()) || '';
      const r = await window.EW.api(`/api/taste/wall?syncKey=${encodeURIComponent(key)}`);
      state.data = r;
      render();
    } catch (e) {
      const grid = $('wall-grid');
      if (grid) grid.innerHTML = `<div class="wall-foot">墙面取不到：${esc(e.message)}</div>`;
    } finally {
      state.loading = false;
    }
  }

  function render() {
    const d = state.data;
    if (!d) return;
    const meta = $('wall-meta');
    if (meta) {
      meta.textContent = `${d.hung} / ${d.capacity} 张`
        + (d.newIn7d ? ` · 7 天内新增 ${d.newIn7d} 张` : '')
        + (d.hasMore ? ` · 另有 ${d.total - d.capacity} 张在下一面墙` : '');
    }
    const grid = $('wall-grid');
    if (!grid) return;
    grid.innerHTML = '';
    d.slots.forEach((item, i) => {
      const tile = document.createElement('div');
      if (!item) {
        tile.className = 'wall-tile empty';
        tile.title = '空位：钉子已经钉好了';
        grid.appendChild(tile);
        return;
      }
      tile.className = 'wall-tile' + (item.isNew ? ' is-new' : '') + (item.cover ? '' : ' no-cover');
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
      foot.innerHTML = d.total === 0
        ? '墙上还空着。听一首歌，第一枚钉子就会挂上东西。'
        : `已挂 ${d.hung} 张 · 墙面 ${d.capacity} 格 · 最近听的先上墙${d.hasMore ? '，满格后接着往第二面挂' : '。'}`;
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
    document.addEventListener('ew:page', (e) => { if (e.detail === 'page-wall') load(true); });
    load(false);
  }

  window.Wall = { openPage, load, debug: () => ({ total: state.data && state.data.total }) };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
})();
