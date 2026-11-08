'use strict';

// 运行时选择：mac 端 Electron 壳里直接用原生 BrowserWindow；
// 纯 Node 的 Web 服务退回到本机 Chrome（CDP 实现同等的 webRequest 拦截）。
let runtime = null;
try {
  const electron = require('electron');
  if (electron && electron.BrowserWindow && electron.session && electron.app) runtime = electron;
} catch { /* 非 Electron 环境 */ }

const shim = runtime ? null : require('./chromium-runtime');
module.exports = runtime || shim;
module.exports.isChromiumShim = !!shim;
