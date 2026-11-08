/* 闻曲 Earworm — 开机动画控制层
 *
 * 分工：视觉分镜与自动退场时序全部由 index.html 内联的 #boot-critical 样式驱动。
 * 即使本脚本加载失败或抛错，CSS 也会在约 1.58s 自动淡出并置为 hidden，
 * 不会把用户挡在首页外面。这里只负责三件事：
 *   1) 随机一句诗（与首页侧栏同源）
 *   2) 跳过交互：点任意处 / 右上角透明按钮 / 任意键
 *   3) 到点清理节点，并处理后台标签页的动画挂起
 *
 * 不写入任何 localStorage —— 每次打开 web（新文档）都会展示一次。
 * 站内切页不重播，因为它不是新的文档加载。
 */
(function () {
  'use strict';
  var boot = document.getElementById('boot');
  if (!boot) return;

  var POEMS = [
    '此曲只应天上有，人间能得几回闻。',
    '为我一挥手，如听万壑松。',
    '转轴拨弦三两声，未成曲调先有情。',
    '余音绕梁，三日不绝。',
    '谁家玉笛暗飞声，散入春风满洛城。',
    '嘈嘈切切错杂弹，大珠小珠落玉盘。',
  ];
  var poemEl = document.getElementById('boot-poem');
  if (poemEl) poemEl.textContent = POEMS[Math.floor(Math.random() * POEMS.length)];

  var reduce = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  var START = Date.now();
  var DURATION = reduce ? 0 : 1580;   // bootExit: 1.28s delay + .30s
  var done = false;
  var timer = null;

  function finish(skipped) {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('visibilitychange', onVisible);
    boot.removeEventListener('pointerdown', onSkip);
    var skipBtn = document.getElementById('boot-skip');
    if (skipBtn) skipBtn.removeEventListener('click', onSkip);

    var animateSkip = skipped && !reduce;
    boot.classList.add(animateSkip ? 'is-skipped' : 'is-done');
    document.documentElement.classList.add('boot-done');
    window.setTimeout(function () {
      if (boot.parentNode) boot.remove();
    }, animateSkip ? 180 : 60);
  }

  function onSkip() { finish(true); }

  function onKey(e) {
    if (done) return;
    // 修饰键与 Tab 不算「任意键」：Tab 要留给跳过按钮做焦点导航
    if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab'].indexOf(e.key) >= 0) return;
    // 用 window 捕获阶段截住按键，避免「跳过」的空格 / 字母同时触发播放器快捷键
    e.preventDefault();
    e.stopImmediatePropagation();
    finish(true);
  }

  function onVisible() {
    // 后台标签里动画可能被挂起，回到前台时按真实耗时立即收场
    if (!document.hidden && Date.now() - START >= DURATION) finish(false);
  }

  boot.addEventListener('pointerdown', onSkip);
  var skipBtn = document.getElementById('boot-skip');
  if (skipBtn) skipBtn.addEventListener('click', onSkip);
  window.addEventListener('keydown', onKey, true);
  document.addEventListener('visibilitychange', onVisible);

  // 兜底：CSS 动画未触发 / 长时间后台，也一定把遮罩撤掉
  timer = window.setTimeout(function () { finish(false); }, DURATION + 80);
  if (reduce) finish(false);
})();
