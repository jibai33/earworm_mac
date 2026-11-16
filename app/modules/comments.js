// ====================================================================
//  统一评论层（闻曲 Earworm）
//  四平台一套出入参，前端不需要知道每个平台的分页单位长什么样：
//    - 网易云：offset / limit，comment_music 读、comment 写
//    - QQ 音乐：pagenum / pagesize，fcg_global_comment_h5.fcg 读与写
//    - 汽水：cursor / count，handleQishuiComments 读、handleQishuiCreateComment 写
//    - 小宇宙：上游没有开放评论接口，如实回 unsupported，不编造
//
//  设计取向：
//    1. 失败要能被用户读懂 —— 每个分支都带回 note / needLogin，而不是只丢一句 error
//    2. 分页用「不透明游标」nextToken，前端把它原样回传，平台换了也不用改前端
//    3. 只读上游给的东西，不补造评论、不缓存他人言论
// ====================================================================

const PLATFORMS = {
  netease: '网易云音乐',
  qq: 'QQ 音乐',
  qishui: '汽水音乐',
  xy: '小宇宙',
};

const MAX_LEN = 300;

function clampInt(v, lo, hi, def) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, n));
}

// 平台各自的「点进去会看到什么」提示，未接通的平台也要说明白
const UNSUPPORTED_NOTE = {
  xy: '小宇宙没有开放评论接口，这里只能听节目',
};

function createComments(deps) {
  const {
    neteaseCommentMusic, neteaseComment,
    qishuiApi, qqApi,
    getNeteaseCookie, getQishuiCookie, getQQCookie,
  } = deps;

  function platformOf(provider) {
    const key = String(provider || 'netease').toLowerCase();
    return { key, label: PLATFORMS[key] || key };
  }

  /* ---------- 归一化 ---------- */
  function mapNetease(c) {
    const u = (c && c.user) || {};
    return {
      id: String((c && c.commentId) || ''),
      content: String((c && c.content) || '').trim(),
      likedCount: Number((c && c.likedCount) || 0) || 0,
      time: Number((c && c.time) || 0) || 0,
      isHot: false,
      reply: (c && c.beReplied && c.beReplied[0] && c.beReplied[0].content) ? String(c.beReplied[0].content).trim() : '',
      user: { nickname: u.nickname || '云村村民', avatar: u.avatarUrl || '' },
    };
  }

  function mapQishui(c) {
    const u = (c && c.user) || {};
    return {
      id: String((c && c.id) || ''),
      content: String((c && c.content) || '').trim(),
      likedCount: Number((c && c.likedCount) || 0) || 0,
      time: Number((c && c.time) || 0) || 0,
      isHot: false,
      reply: (c && c.reply) ? String(c.reply).trim() : '',
      user: { nickname: u.nickname || '汽水用户', avatar: u.avatar || '' },
    };
  }

  /* ---------- 读 ---------- */
  async function readNetease(opts) {
    const cookie = getNeteaseCookie ? getNeteaseCookie() : '';
    const r = await neteaseCommentMusic({
      id: opts.id, limit: opts.limit, offset: opts.offset, cookie, timestamp: Date.now(),
    });
    const b = (r && r.body) || {};
    if (b.code && b.code !== 200) {
      return { ok: false, error: b.message || b.msg || ('网易云返回 code ' + b.code), needLogin: b.code === 301 };
    }
    const hot = (b.hotComments || []).map(mapNetease).filter(c => c.content).map(c => Object.assign({}, c, { isHot: true }));
    const list = (b.comments || []).map(mapNetease).filter(c => c.content);
    const total = Number(b.total) || 0;
    const seen = Number(b.more) === false || list.length < opts.limit;
    return {
      ok: true,
      total,
      hot: opts.offset === 0 ? hot.slice(0, 8) : [],
      comments: list,
      hasMore: !seen && (total ? opts.offset + list.length < total : list.length >= opts.limit),
      nextToken: String(opts.offset + list.length),
    };
  }

  async function readQQ(opts) {
    const cookie = getQQCookie ? getQQCookie() : '';
    const songId = Number(opts.songId || opts.id) || 0;
    const page = Math.floor(opts.offset / opts.limit);
    const r = await qqApi.handleQQComments(songId, { limit: opts.limit, page, type: opts.type }, cookie);
    if (r.error) return { ok: false, error: r.error, needLogin: /登录/.test(r.error) };
    const hot = (r.hotComments || []);
    const list = (r.comments || []);
    // 第 0 页的最新列表里本来就混着热评，按 id 去一次重，免得同一条出现两遍
    const hotIds = new Set(hot.map(c => c.id));
    const rest = opts.offset === 0 ? list.filter(c => !hotIds.has(c.id)) : list;
    return {
      ok: true,
      total: r.total || 0,
      hot: opts.offset === 0 ? hot.slice(0, 8) : [],
      comments: rest,
      hasMore: !!r.hasMore,
      nextToken: String((page + 1) * opts.limit),
    };
  }

  async function readQishui(opts) {
    if (!qishuiApi || !qishuiApi.handleQishuiComments) {
      return { ok: false, error: '汽水模块未加载，评论暂不可用' };
    }
    const cookie = getQishuiCookie ? getQishuiCookie() : '';
    const r = await qishuiApi.handleQishuiComments(opts.id, {
      limit: opts.limit, offset: opts.offset, cursor: opts.cursor || '',
    }, cookie);
    if (r.error === 'QISHUI_COOKIE_REQUIRED') {
      return { ok: false, error: '汽水评论区需要登录后才能查看', needLogin: true };
    }
    if (r.error) return { ok: false, error: r.error };
    const list = (r.comments || []).map(mapQishui).filter(c => c.content);
    return {
      ok: true,
      total: Number(r.total) || 0,
      hot: [],
      comments: list,
      hasMore: !!r.hasMore,
      nextToken: String(r.nextCursor || (opts.offset + list.length)),
    };
  }

  async function read(opts) {
    opts = opts || {};
    const { key, label } = platformOf(opts.provider);
    const base = {
      provider: key, platform: label,
      offset: Math.max(0, parseInt(opts.offset, 10) || 0),
      limit: clampInt(opts.limit, 1, 50, 20),
      cursor: String(opts.cursor || ''),
    };
    const id = String(opts.id || base.cursor || '');

    if (key === 'xy') {
      return Object.assign(base, {
        ok: true, unsupported: true, total: 0, hot: [], comments: [],
        hasMore: false, nextToken: '', note: UNSUPPORTED_NOTE.xy,
      });
    }
    if (!id && key !== 'qq') {
      return Object.assign(base, { ok: false, error: '缺少曲目 id，取不到评论' });
    }
    if (key === 'qq' && !Number(opts.songId || opts.id)) {
      return Object.assign(base, { ok: false, error: '这首 QQ 曲目没有数字 id，取不到评论' });
    }

    const o = Object.assign({}, base, { id, songId: opts.songId, type: opts.type || '' });
    let r;
    try {
      if (key === 'netease') r = await readNetease(o);
      else if (key === 'qq') r = await readQQ(o);
      else if (key === 'qishui') r = await readQishui(o);
      else return Object.assign(base, { ok: false, error: '暂不支持该平台的评论区' });
    } catch (e) {
      return Object.assign(base, { ok: false, error: '评论加载失败：' + ((e && e.message) || '网络异常') });
    }
    return Object.assign(base, r, {
      platform: label,
      // 上游一句中文都没有时，前端要能给出可读解释
      note: r.ok ? '' : (r.needLogin ? '需要登录 ' + label + ' 才能看评论' : ''),
    });
  }

  /* ---------- 写 ---------- */
  async function write(opts) {
    opts = opts || {};
    const { key, label } = platformOf(opts.provider);
    const content = String(opts.content || '').trim();
    if (!content) return { ok: false, provider: key, platform: label, error: '先写点什么再发' };
    if (content.length > MAX_LEN) return { ok: false, provider: key, platform: label, error: `最多 ${MAX_LEN} 字` };
    if (key === 'xy') return { ok: false, provider: key, platform: label, error: '小宇宙没有开放评论接口' };

    try {
      if (key === 'netease') {
        const cookie = getNeteaseCookie ? getNeteaseCookie() : '';
        if (!cookie) return { ok: false, provider: key, platform: label, needLogin: true, error: '需要登录网易云音乐才能发评论' };
        const r = await neteaseComment({ t: 1, type: 0, id: opts.id, content, cookie, timestamp: Date.now() });
        const b = (r && r.body) || {};
        if (b.code === 200) {
          const c = b.comment || {};
          return { ok: true, provider: key, platform: label, comment: mapNetease(c.id ? c : { content, user: {} }) };
        }
        if (b.code === 301 || b.code === 250) {
          return { ok: false, provider: key, platform: label, needLogin: true, error: '网易云登录态已失效，请重新登录' };
        }
        return { ok: false, provider: key, platform: label, error: b.message || b.msg || ('网易云返回 code ' + (b.code || '?')) };
      }

      if (key === 'qq') {
        const cookie = getQQCookie ? getQQCookie() : '';
        const r = await qqApi.handleQQPostComment(Number(opts.songId || opts.id) || 0, content, cookie);
        return Object.assign({ platform: label }, r);
      }

      if (key === 'qishui') {
        const cookie = getQishuiCookie ? getQishuiCookie() : '';
        const r = await qishuiApi.handleQishuiCreateComment(opts.id, content, cookie);
        if (r && r.ok) {
          const echo = r.comment
            ? mapQishui(r.comment)
            : { id: 'me_' + Date.now(), content, likedCount: 0, time: Date.now(), isHot: false, reply: '', user: { nickname: '我', avatar: '' } };
          return { ok: true, provider: key, platform: label, comment: echo };
        }
        return { ok: false, provider: key, platform: label, error: (r && r.error) || '汽水返回了未知错误' };
      }
      return { ok: false, provider: key, platform: label, error: '暂不支持该平台发评论' };
    } catch (e) {
      const msg = (e && e.message) || '网络异常';
      const needLogin = /COOKIE_REQUIRED|login|401|未登录/i.test(msg);
      return {
        ok: false, provider: key, platform: label, needLogin,
        error: needLogin ? `需要登录 ${label} 才能发评论` : '发送失败：' + msg,
      };
    }
  }

  return { read, write, platforms: PLATFORMS, unsupportedNote: UNSUPPORTED_NOTE, MAX_LEN };
}

module.exports = { createComments, PLATFORMS, UNSUPPORTED_NOTE, MAX_LEN };
