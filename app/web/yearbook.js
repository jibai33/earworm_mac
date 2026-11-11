/* ====================================================================
   闻曲 · 听觉年鉴（前端）
   ---------------------------------------------------------------
   · 数据来自 /api/taste/yearbook（本机事件流，近 30 天）
   · 版面规则：标题必须是一件具体的事，数字只在撑得住故事的地方出现
   · 「撕下来存 PNG」用 canvas 重画一遍（不引第三方截图库），默认不含账号信息
   ==================================================================== */
(function () {
  const $ = (id) => document.getElementById(id);
  const state = { data: null, loading: false };
  const esc = (s) => String(s || '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const CN_MONTH = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];

  async function load(force) {
    if (state.loading) return;
    if (!force && state.data) { render(); return; }
    state.loading = true;
    try {
      const key = (window.Taste && Taste.getSyncKey && Taste.getSyncKey()) || '';
      const r = await window.EW.api(`/api/taste/yearbook?syncKey=${encodeURIComponent(key)}`);
      state.data = r;
      render();
    } catch (e) {
      const t = $('yb-title');
      if (t) t.textContent = `小报印不出来：${e.message}`;
    } finally {
      state.loading = false;
    }
  }

  function render() {
    const d = state.data;
    if (!d) return;
    const m = new Date().getMonth() + 1;
    const issue = $('yb-issue');
    if (issue) issue.textContent = `${CN_MONTH[m - 1]}月号 · 第 ${m} 期`;

    $('yb-title').textContent = d.headline ? d.headline.title : d.title;
    $('yb-dek').textContent = d.headline ? d.headline.dek : d.dek;
    $('yb-period').textContent = d.period ? d.period.label : '—';
    $('yb-note').textContent = d.note || '';

    const nums = $('yb-nums');
    if (nums) {
      nums.hidden = !!d.empty;
      if (!d.empty) {
        $('yb-plays').textContent = String(d.nums.plays);
        $('yb-songs').textContent = String(d.nums.songs);
        $('yb-rate').textContent = d.nums.completeRate + '%';
      }
    }

    const chart = $('yb-chart');
    if (chart) {
      const max = Math.max(1, ...(d.hours || [0]));
      const peakSet = new Set((d.peaks || []).map((p) => p.h));
      chart.innerHTML = (d.hours || []).map((n, h) => {
        const pct = Math.round((n / max) * 100);
        return `<i class="${peakSet.has(h) && n > 0 ? 'hot' : ''}" style="height:${Math.max(2, pct)}%"></i>`;
      }).join('');
    }
    const peak = $('yb-peak');
    if (peak) peak.textContent = d.peakText || '';

    const skips = $('yb-skips');
    if (skips) {
      skips.innerHTML = (d.skips || []).length
        ? d.skips.map((s) => `<li><span>${esc(s.name)}</span><span>连跳 ${s.count} 次</span></li>`).join('')
        : '<li><span>没有反复跳过的歌</span><span>—</span></li>';
    }
    const fl = $('yb-firstlike');
    if (fl) {
      fl.innerHTML = d.firstLike
        ? `${fmtShort(d.firstLike.at)} · 《${esc(d.firstLike.name)}》`
        : '这段时间还没点过红心';
    }
    const body = $('yb-body');
    if (body) body.hidden = !!d.empty;

    const fine = $('yb-fineprint');
    if (fine) {
      const c = d.counts || {};
      const bits = [];
      if (c.search) bits.push(`搜了 ${c.search} 次`);
      if (c.skip) bits.push(`跳了 ${c.skip} 次`);
      if (c.like) bits.push(`点了 ${c.like} 次红心`);
      if (c.view) bits.push(`翻过 ${c.view} 个角落`);
      fine.textContent = bits.length
        ? `这个月你还${bits.join('、')}。数字只写这一行，剩下的留给具体的歌。`
        : '';
    }
  }

  function fmtShort(ts) {
    const d = new Date(Number(ts) || 0);
    return `${d.getMonth() + 1}.${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  /* ---------- 存成 PNG ---------- */
  function wrap(ctx, text, maxW) {
    const out = [];
    let line = '';
    for (const ch of String(text || '')) {
      const next = line + ch;
      if (ctx.measureText(next).width > maxW && line) { out.push(line); line = ch; }
      else line = next;
    }
    if (line) out.push(line);
    return out;
  }

  async function exportPNG() {
    const d = state.data;
    if (!d) return;
    try { await document.fonts.load('20px "Ark Pixel 12"'); } catch { /* 用系统字兜底 */ }
    const W = 900, H = 1240;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c = cv.getContext('2d');
    const F = (size) => `${size}px "Ark Pixel 12", "PingFang SC", monospace`;
    const ink = '#221f18', dim = '#5c5347';

    c.fillStyle = '#e7e0cd'; c.fillRect(0, 0, W, H);
    c.strokeStyle = '#0b0e12'; c.lineWidth = 4; c.strokeRect(2, 2, W - 4, H - 4);

    let y = 78;
    c.fillStyle = ink; c.font = F(34); c.textBaseline = 'alphabetic';
    c.fillText('闻 曲 小 报', 56, y);
    c.fillStyle = dim; c.font = F(16);
    const m = new Date().getMonth() + 1;
    c.textAlign = 'right';
    c.fillText(`${CN_MONTH[m - 1]}月号 · 第 ${m} 期`, W - 56, y - 4);
    c.textAlign = 'left';

    y += 26; c.strokeStyle = ink; c.lineWidth = 4;
    c.beginPath(); c.moveTo(56, y); c.lineTo(W - 56, y); c.stroke();

    y += 34; c.fillStyle = dim; c.font = F(16);
    c.fillText('听 觉 年 鉴', 56, y);
    c.textAlign = 'right'; c.fillText(d.period ? d.period.label : '', W - 56, y); c.textAlign = 'left';

    y += 20; c.strokeStyle = ink; c.lineWidth = 2;
    c.beginPath(); c.moveTo(56, y); c.lineTo(W - 56, y); c.stroke();

    y += 54; c.fillStyle = ink; c.font = F(30);
    const title = (d.headline && d.headline.title) || d.title || '';
    for (const line of wrap(c, title, W - 112)) { c.fillText(line, 56, y); y += 44; }

    y += 6; c.fillStyle = dim; c.font = F(18);
    for (const line of wrap(c, (d.headline && d.headline.dek) || d.dek || '', W - 130)) {
      c.fillText(line, 70, y); y += 30;
    }

    if (!d.empty && d.nums) {
      y += 14; c.strokeStyle = '#b9b09a'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(56, y); c.lineTo(W - 56, y); c.stroke();
      y += 44; c.fillStyle = ink; c.font = F(30);
      const items = [[String(d.nums.plays), '次播放'], [String(d.nums.songs), '首'], [d.nums.completeRate + '%', '完播率']];
      let x = 56;
      const units = [' 次播放', ' 首', ' 完播率'];
      items.forEach((it, i) => {
        c.fillStyle = ink; c.font = F(32); c.fillText(it[0], x, y);
        const w = c.measureText(it[0]).width;
        c.fillStyle = dim; c.font = F(16); c.fillText(units[i], x + w + 4, y);
        x += w + 40 + c.measureText(units[i]).width;
      });
      // 24 小时柱状图
      y += 26;
      const chartH = 150, base = y + chartH;
      const bw = (W - 112 - 23 * 4) / 24;
      const max = Math.max(1, ...(d.hours || [0]));
      (d.hours || []).forEach((n, h) => {
        const bh = Math.max(3, Math.round((n / max) * chartH));
        const hot = (d.peaks || []).some((p) => p.h === h) && n > 0;
        c.fillStyle = hot ? '#a8452f' : ink;
        c.fillRect(56 + h * (bw + 4), base - bh, bw, bh);
      });
      y = base + 6;
      c.strokeStyle = ink; c.lineWidth = 2;
      c.beginPath(); c.moveTo(56, y); c.lineTo(W - 56, y); c.stroke();
      y += 24; c.fillStyle = dim; c.font = F(16);
      c.fillText('00', 56, y); c.fillText('06', 56 + (W - 112) * .25, y);
      c.fillText('12', 56 + (W - 112) * .5, y); c.fillText('18', 56 + (W - 112) * .75, y);
      c.textAlign = 'right'; c.fillText('24', W - 56, y); c.textAlign = 'left';
      y += 40; c.fillStyle = ink; c.font = F(18);
      for (const line of wrap(c, d.peakText || '', W - 112)) { c.fillText(line, 56, y); y += 30; }

      if ((d.skips || []).length) {
        y += 10; c.fillStyle = dim; c.font = F(16);
        c.fillText('最 常 跳 过', 56, y); y += 30;
        c.fillStyle = ink; c.font = F(18);
        for (const s of d.skips) {
          c.fillText(`《${s.name}》`, 56, y);
          c.textAlign = 'right'; c.fillStyle = dim;
          c.fillText(`连跳 ${s.count} 次`, W - 56, y); c.textAlign = 'left'; c.fillStyle = ink;
          y += 28;
        }
      }
    }

    c.fillStyle = dim; c.font = F(16);
    const noteLines = wrap(c, d.note || '本机生成 · 不出网', W - 112);
    let ny = H - 90;
    noteLines.slice(-2).forEach((line) => { c.fillText(line, 56, ny); ny += 26; });

    // 红章
    c.save();
    c.translate(W - 120, H - 96); c.rotate(-4 * Math.PI / 180);
    c.strokeStyle = '#a8452f'; c.lineWidth = 3; c.strokeRect(-46, -30, 92, 60);
    c.fillStyle = '#a8452f'; c.font = F(18); c.textAlign = 'center';
    c.fillText('本 期', 0, -4); c.fillText('存 档', 0, 22);
    c.restore();

    const url = cv.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    const d0 = new Date();
    a.download = `闻曲小报-${d0.getFullYear()}${String(d0.getMonth() + 1).padStart(2, '0')}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    const hint = document.querySelector('.yb-hint');
    if (hint) hint.textContent = '已存到下载文件夹（不含账号信息）';
  }

  function openPage() {
    window.EW.go('page-yearbook');
    load(true);
  }

  function bind() {
    const entry = $('yearbook-entry');
    if (entry) entry.addEventListener('click', openPage);
    const ex = $('yb-export');
    if (ex) ex.addEventListener('click', exportPNG);
    document.addEventListener('ew:page', (e) => { if (e.detail === 'page-yearbook') load(true); });
    load(false);
  }

  window.Yearbook = { openPage, load, exportPNG, debug: () => ({ has: !!state.data }) };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
})();
