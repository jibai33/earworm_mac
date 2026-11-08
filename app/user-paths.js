'use strict';

// 可写数据目录解析
// ------------------------------------------------------------------
// Web 版把凭据与听感画像写在工程目录里即可；macOS 桌面版打包后，
// app/ 位于 .app 包内（只读、且写入会破坏签名），必须重定向到
// ~/Library/Application Support/Earworm。Electron 主进程通过
// EARWORM_DATA_DIR 注入真实路径；纯 Node 运行时退回 app/data。

const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const DATA_DIR = process.env.EARWORM_DATA_DIR
  ? path.resolve(process.env.EARWORM_DATA_DIR)
  : path.join(ROOT, 'data');

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (err) {
  console.error('[user-paths] 无法创建数据目录', DATA_DIR, err.message);
}

function dataFile(name) {
  return path.join(DATA_DIR, name);
}

module.exports = { ROOT, DATA_DIR, dataFile };
