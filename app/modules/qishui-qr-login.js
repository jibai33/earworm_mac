'use strict';

// Focused authentication bridge ported from
// Wx2yZx/Mineradio-Qishui-QR-Login revision
// aaadaab7d011714f94fbe45b382ba8dcc7cf17b9 (GPL-3.0-only).

const fs = require('fs');
const os = require('os');
const path = require('path');
const qishuiAuthV6 = require('./qishui-auth-v6');

const DEFAULT_CONFIG_FILE = require('../user-paths').dataFile('.qishui-qr-login.json');

function defaultConfig() {
  return {
    deviceId: '',
    installId: '',
    verifyPortraitId: '',
    computerName: os.hostname() || 'Windows-PC',
    cookie: '',
    msToken: '',
  };
}

function readConfig(file) {
  try {
    if (!file || !fs.existsSync(file)) return defaultConfig();
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return { ...defaultConfig(), ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch (error) {
    console.warn('[QishuiQrLogin] ignored invalid config:', error && error.message || error);
    return defaultConfig();
  }
}

function writeConfig(file, value) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function hasLoginCookie(cookie) {
  return /(?:^|;\s*)(?:sessionid|sessionid_ss|sid_guard|sid_tt)=[^;\s]+/i.test(String(cookie || ''));
}

function createQishuiQrLoginBridge(options) {
  options = options && typeof options === 'object' ? options : {};
  const auth = options.auth || qishuiAuthV6;
  const configFile = options.configFile || process.env.QISHUI_QR_CONFIG_FILE || DEFAULT_CONFIG_FILE;
  let config = {
    ...readConfig(configFile),
    ...(options.initialConfig && typeof options.initialConfig === 'object' ? options.initialConfig : {}),
  };
  let qrGeneration = 0;
  // 签发过的二维码不互斥：用户可能连点两次刷新、或在首次生成很慢时切走再切回，
  // 前一张码还在手机上显示着。只要它还在地签发时间窗内，就应该允许被查询，
  // 而不是一有新码就把旧码判成「已过期」。
  const issuedTokens = new Map(); // token -> 签发时间戳
  const TOKEN_TTL_MS = 15 * 60 * 1000;
  let confirmedQrToken = '';
  let confirmedQrResult = null;
  let qrPending = false;

  function getConfig() {
    return { ...config };
  }

  function updateConfig(partial) {
    partial = partial && typeof partial === 'object' ? partial : {};
    config = { ...config, ...partial };
    writeConfig(configFile, config);
    return getConfig();
  }

  auth.configure({ getConfig, updateConfig });

  async function createQrCode() {
    qrGeneration += 1;
    confirmedQrToken = '';
    confirmedQrResult = null;
    qrPending = true;
    const result = await auth.getQrCode();
    const data = result && result.data || {};
    if (!data.token || !data.qrcode) {
      const error = new Error('QISHUI_QR_PAYLOAD_INCOMPLETE');
      error.code = 'QISHUI_QR_PAYLOAD_INCOMPLETE';
      throw error;
    }
    // 注意：即使这次是「被替换掉的那一次」，token 也要记下来 —— 前端可能已经把它
    // 显示给用户了，用户正拿着它扫码。返回给前端的调用方仍按 generation 丢弃旧结果。
    const now = Date.now();
    issuedTokens.set(String(data.token), now);
    for (const [token, at] of issuedTokens) {
      if (now - at > TOKEN_TTL_MS) issuedTokens.delete(token);
    }
    return result;
  }

  async function checkQrConnect(token) {
    token = String(token || '').trim();
    if (!token) {
      const error = new Error('QISHUI_QR_TOKEN_REQUIRED');
      error.code = 'QISHUI_QR_TOKEN_REQUIRED';
      throw error;
    }
    const issuedAt = issuedTokens.get(token);
    // 只有「这台机器根本没签发过」或「超出签发时间窗」才判定过期；
    // 否则一律交给官方接口判断，避免把用户正在扫的码误报成失效。
    if (!issuedAt || Date.now() - issuedAt > TOKEN_TTL_MS) {
      issuedTokens.delete(token);
      return { message: 'error', data: { error_code: 2, status: 'expired', confirmed: false } };
    }
    if (confirmedQrToken === token && confirmedQrResult) return confirmedQrResult;
    const result = await auth.checkQrConnect(token);
    const data = result && result.data || {};
    // 官方返回「已确认」就算确认，不再要求本地 cookie 已经落地：
    // 确认成功这一次如果因为 cookie 没写进来而返回 confirmed=false，
    // 前端会继续轮询，而官方对已消费的 token 下一轮就回 error_code 2，
    // 用户看到的现象正是「手机确认了、电脑说二维码失效」。
    const confirmed = Number(data.error_code) === 0 &&
      (String(data.status) === '3' || String(data.status) === 'confirmed' || !!data.session_cookie);
    if (confirmed) {
      confirmedQrToken = token;
      qrPending = false;
      confirmedQrResult = { ...result, data: { ...data, confirmed: true } };
      return confirmedQrResult;
    }
    if (Number(data.error_code) === 2 || String(data.status) === 'expired') issuedTokens.delete(token);
    return { ...result, data: { ...data, confirmed } };
  }

  function getCookie() {
    return String(config.cookie || '').trim();
  }

  function getStatus() {
    const cookie = getCookie();
    const cookieReady = hasLoginCookie(cookie);
    return {
      provider: 'qishui',
      // 只看凭据本身：只要 cookie 里有 session，就是已登录。
      // 二维码在不在等确认（qrPending）与登录态无关，不能拿它否定已登录。
      loggedIn: cookieReady,
      cookieReady,
      qrPending,
      qrConfirmed: !!confirmedQrToken && issuedTokens.has(confirmedQrToken),
      deviceId: String(config.deviceId || ''),
      msTokenReady: !!config.msToken,
      configFile,
    };
  }

  async function clear() {
    qrGeneration += 1;
    issuedTokens.clear();
    confirmedQrToken = '';
    confirmedQrResult = null;
    qrPending = false;
    await auth.clear();
    updateConfig({ cookie: '', msToken: '' });
    return getStatus();
  }

  return {
    createQrCode,
    checkQrConnect,
    getCookie,
    getStatus,
    clear,
    _test: { getConfig, updateConfig, configFile },
  };
}

const bridge = createQishuiQrLoginBridge();

module.exports = Object.assign(bridge, {
  createQishuiQrLoginBridge,
  hasLoginCookie,
});
