'use strict';

// 生成 macOS 应用图标与菜单栏模板图标（像素风）
// 用法：node scripts/make-icons.js
// 依赖本机 Chrome + puppeteer-core；输出 build/icon.icns、build/trayTemplate.png
//
// 设计说明：
//   应用图标复用 app/web/icon.svg 的 8-bit 图形（32×32 网格，单格 16 单位），
//   在 1024 画布上居中放大到 880×880，留出 macOS 大图标规范的安全边距；
//   矢量放大 + shape-rendering:crispEdges，边缘仍是整数像素方块。
//   菜单栏图标是 11×11 格的纯黑 template 音符。

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const TMP = path.join(BUILD, '.tmp');
const ICON_SVG = path.join(ROOT, 'app', 'web', 'icon.svg');

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('未找到本机 Chrome/Edge，无法渲染图标');
}

/* ---------------- 应用图标 ---------------- */
const ICON_HTML = (svg) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:1024px;height:1024px;background:transparent;overflow:hidden}
  .wrap{position:absolute;left:72px;top:72px;width:880px;height:880px}
  .wrap svg{display:block;width:880px;height:880px}
</style></head><body>
  <div class="wrap">${svg.replace(/^[\s\S]*?<svg/, '<svg').replace(/<\/svg>[\s\S]*$/, '</svg>')}</div>
</body></html>`;

/* ---------------- 菜单栏模板图标（纯黑 + alpha，11×11 格） ---------------- */
// 11 格 × 22pt：@1x 每格 2px、@2x 每格 4px，正好落在整数像素上
const NOTE_CELLS = [
  // 符尾
  [6, 1, 4, 1], [8, 2, 2, 1], [8, 3, 1, 1],
  // 符干
  [6, 1, 2, 9],
  // 符头
  [3, 6, 5, 1], [2, 7, 6, 1], [2, 8, 6, 1], [3, 9, 5, 1],
];

const TRAY_HTML = (px) => {
  const rects = NOTE_CELLS
    .map(([x, y, w, h]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}"/>`)
    .join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:transparent;overflow:hidden}
  svg{display:block;width:${px}px;height:${px}px}
</style></head><body>
  <svg viewBox="0 0 11 11" shape-rendering="crispEdges"><g fill="#000">${rects}</g></svg>
</body></html>`;
};

async function shoot(browser, html, file, width, height) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.screenshot({ path: file, omitBackground: true });
  await page.close();
}

(async () => {
  fs.mkdirSync(BUILD, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });

  const svg = fs.readFileSync(ICON_SVG, 'utf8');
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--no-sandbox', '--hide-scrollbars', '--force-color-profile=srgb'],
  });

  // 1. 1024 主图
  const icon1024 = path.join(TMP, 'icon_1024.png');
  await shoot(browser, ICON_HTML(svg), icon1024, 1024, 1024);

  // 2. iconset → icns
  const iconset = path.join(TMP, 'icon.iconset');
  fs.rmSync(iconset, { recursive: true, force: true });
  fs.mkdirSync(iconset, { recursive: true });
  const variants = [
    [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
  ];
  for (const [size, name] of variants) {
    execFileSync('sips', ['-z', String(size), String(size), icon1024, '--out', path.join(iconset, name)], { stdio: 'ignore' });
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(BUILD, 'icon.icns')], { stdio: 'ignore' });
  fs.copyFileSync(icon1024, path.join(BUILD, 'icon.png'));

  // 3. 菜单栏 template（22pt / @2x 44px）
  //    Chrome 在极小视口下截图为空，所以先按 8 倍出图再 sips 整数倍缩小
  for (const [target, name] of [[22, 'trayTemplate.png'], [44, 'trayTemplate@2x.png']]) {
    const big = path.join(TMP, `tray_${target}.png`);
    await shoot(browser, TRAY_HTML(target * 8), big, target * 8, target * 8);
    execFileSync('sips', ['-z', String(target), String(target), big,
      '--out', path.join(BUILD, name)], { stdio: 'ignore' });
  }

  await browser.close();
  fs.rmSync(TMP, { recursive: true, force: true });

  console.log('✓ build/icon.icns');
  console.log('✓ build/icon.png');
  console.log('✓ build/trayTemplate.png / @2x');
})();
