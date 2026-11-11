'use strict';

// ====================================================================
//  菜单栏像素频谱
//  8 段音量 → 18×18pt 的模板图（@2x 36×36）。模板图只用 alpha，
//  macOS 会自动按浅色/深色菜单栏反色，不会出现浅底上看不清的琥珀色。
//  高度按 3px 一档量化，缩到菜单栏尺寸后仍是像素颗粒而不是糊成渐变。
// ====================================================================

const W = 36;
const H = 36;
const BARS = 8;
const BAR_W = 3;
const GAP = 1;
const MAX_H = 24;
const BASE = 2; // 暂停时保留下来的基线高度

/**
 * @param {number[]|null} bands 8 个 0–1 的分段音量；null 表示未在播放
 * @returns {{buffer: Buffer, width: number, height: number}}
 */
function renderTrayBitmap(bands) {
  const buffer = Buffer.alloc(W * H * 4); // BGRA，模板图只看 alpha
  const put = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    buffer[i] = 255;
    buffer[i + 1] = 255;
    buffer[i + 2] = 255;
    buffer[i + 3] = 255;
  };

  const totalW = BARS * BAR_W + (BARS - 1) * GAP;
  const left = Math.floor((W - totalW) / 2);
  const floorY = H - 5; // 让 8 段柱体在 18pt 方框里视觉垂直居中

  for (let i = 0; i < BARS; i++) {
    let height = BASE;
    if (bands) {
      const v = Math.max(0, Math.min(1, Number(bands[i]) || 0));
      height = BASE + Math.round((v * (MAX_H - BASE)) / 3) * 3;
      height = Math.max(BASE, Math.min(MAX_H, height));
    }
    const x = left + i * (BAR_W + GAP);
    for (let y = 0; y < height; y++) {
      for (let w = 0; w < BAR_W; w++) put(x + w, floorY - y);
    }
  }
  return { buffer, width: W, height: H };
}

module.exports = { renderTrayBitmap, W, H, BARS };
