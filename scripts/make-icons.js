'use strict';

// 生成 macOS 应用图标与菜单栏模板图标
// 用法：node scripts/make-icons.js
// 依赖本机 Chrome + puppeteer-core；输出 build/icon.icns、build/trayTemplate.png

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const TMP = path.join(BUILD, '.tmp');

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
const ICON_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:1024px;height:1024px;background:transparent;overflow:hidden}
  .plate{
    position:absolute;left:62px;top:62px;width:900px;height:900px;border-radius:208px;
    background:
      radial-gradient(72% 62% at 30% 18%, #232a33 0%, transparent 62%),
      radial-gradient(60% 60% at 78% 92%, #14232a 0%, transparent 58%),
      linear-gradient(158deg,#12161c 0%,#090b0e 58%,#050608 100%);
    box-shadow:
      inset 0 2px 0 rgba(255,255,255,.10),
      inset 0 0 90px rgba(0,0,0,.65),
      0 26px 70px rgba(0,0,0,.55);
    overflow:hidden;
  }
  /* 墨晕 */
  .ink{position:absolute;border-radius:50%;filter:blur(26px);opacity:.55}
  .ink.a{width:520px;height:520px;left:-90px;top:-40px;background:radial-gradient(circle,rgba(230,176,106,.36),transparent 66%)}
  .ink.b{width:460px;height:460px;right:-120px;bottom:-60px;background:radial-gradient(circle,rgba(143,184,174,.24),transparent 68%)}
  .ink.c{width:380px;height:380px;right:40px;top:60px;background:radial-gradient(circle,rgba(192,57,43,.18),transparent 70%)}
  /* 巨型水印「聞」 */
  .wm{
    position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
    font-family:"Noto Serif SC","Songti SC","STSong",serif;font-weight:700;
    font-size:520px;line-height:1;color:rgba(233,228,216,.035);
    transform:translateY(-4px);
  }
  /* 朱砂印章 */
  .seal{
    position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
    width:392px;height:392px;border-radius:60px;
    background:linear-gradient(158deg,#e05a48 0%,#c0392b 52%,#8f2618 100%);
    box-shadow:
      0 24px 54px rgba(150,32,20,.42),
      inset 0 3px 0 rgba(255,255,255,.28),
      inset 0 -10px 26px rgba(90,18,10,.55);
    display:flex;align-items:center;justify-content:center;
  }
  .seal::after{
    content:'';position:absolute;inset:14px;border-radius:46px;
    border:3px solid rgba(255,240,225,.34);
  }
  .glyph{
    font-family:"Noto Serif SC","Songti SC","STSong",serif;font-weight:700;
    font-size:246px;line-height:1;color:#fff4e6;letter-spacing:.02em;
    text-shadow:0 3px 10px rgba(80,14,8,.45);
    transform:translateY(-6px);
  }
  .gloss{
    position:absolute;inset:0;border-radius:208px;
    background:linear-gradient(196deg,rgba(255,255,255,.16),transparent 34%);
    mix-blend-mode:screen;pointer-events:none;
  }
</style></head><body>
  <div class="plate">
    <div class="ink a"></div><div class="ink b"></div><div class="ink c"></div>
    <div class="wm">聞</div>
    <div class="seal"><span class="glyph">聞</span></div>
    <div class="gloss"></div>
  </div>
</body></html>`;

/* ---------------- 菜单栏模板图标（纯黑 + alpha） ---------------- */
const TRAY_HTML = (size) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:${size}px;height:${size}px;background:transparent;overflow:hidden}
  svg{display:block;width:${size}px;height:${size}px}
</style></head><body>
  <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path fill="#000" d="M20.2 3.1c0-.9-.8-1.6-1.7-1.5l-8.8 1.6c-.8.1-1.4.8-1.4 1.6v10.9a3.9 3.9 0 1 0 2.5 3.6V8.1l9-1.6v7.3a3.9 3.9 0 1 0 2.5 3.6V3.1z"/>
  </svg>
</body></html>`;

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

  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--no-sandbox', '--hide-scrollbars', '--force-color-profile=srgb'],
  });

  // 1. 1024 主图
  const icon1024 = path.join(TMP, 'icon_1024.png');
  await shoot(browser, ICON_HTML, icon1024, 1024, 1024);

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
  await shoot(browser, TRAY_HTML(22), path.join(BUILD, 'trayTemplate.png'), 22, 22);
  await shoot(browser, TRAY_HTML(44), path.join(BUILD, 'trayTemplate@2x.png'), 44, 44);

  await browser.close();
  fs.rmSync(TMP, { recursive: true, force: true });

  console.log('✓ build/icon.icns');
  console.log('✓ build/icon.png');
  console.log('✓ build/trayTemplate.png / @2x');
})();
