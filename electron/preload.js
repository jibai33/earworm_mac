'use strict';

// ====================================================================
//  闻曲 macOS · 渲染层桥
//  职责：注入桌面版外观 / 关闭 Service Worker / 采集播放状态上报主进程
//        / 接收菜单与迷你播放器的控制指令 / 接入系统「正在播放」
//  不改动 app/web 里的任何业务逻辑，全部通过 DOM 事件驱动
// ====================================================================

const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

/* ---------- 1. 桌面版外观 ---------- */
function injectChrome() {
  if (!document.head || document.getElementById('ew-mac-chrome')) return;
  try {
    const css = fs.readFileSync(path.join(__dirname, 'mac-chrome.css'), 'utf8');
    const style = document.createElement('style');
    style.id = 'ew-mac-chrome';
    style.textContent = css;
    document.head.appendChild(style);
  } catch (err) {
    console.error('[mac] 外观注入失败', err.message);
  }

  document.documentElement.classList.add('is-macos-app');

  if (!document.querySelector('.ew-drag-strip')) {
    const strip = document.createElement('div');
    strip.className = 'ew-drag-strip';
    document.body.prepend(strip);
  }
}

/* ---------- 2. 关闭 Service Worker（桌面版随应用更新，避免旧缓存） ---------- */
try {
  const SWC = window.ServiceWorkerContainer;
  if (SWC && SWC.prototype && SWC.prototype.register) {
    SWC.prototype.register = function register() {
      // 返回永不 resolve 的 Promise：页面里的注册调用静默失效，也不产生未捕获异常
      return new Promise(() => {});
    };
  }
} catch { /* ignore */ }

/* ---------- 3. 播放状态采集 ---------- */
const $ = (id) => document.getElementById(id);

function readState() {
  const audio = $('audio');
  const coverEl = $('mini-cover');
  const likeEl = $('mini-like');
  return {
    playing: audio ? !audio.paused && !audio.ended : false,
    name: ($('mini-name') || {}).textContent || '',
    artist: ($('mini-artist') || {}).textContent || '',
    cover: coverEl && coverEl.src ? coverEl.src : '',
    position: audio ? Math.round((audio.currentTime || 0) * 10) / 10 : 0,
    duration: audio ? Math.round((audio.duration || 0) * 10) / 10 : 0,
    liked: likeEl ? likeEl.classList.contains('on') : false,
    muted: audio ? !!audio.muted : false,
    volume: audio ? Math.round((audio.volume ?? 1) * 100) : 100,
  };
}

let lastKey = '';
let lastMeta = '';

function pushState(force) {
  const state = readState();
  const key = [state.name, state.artist, state.cover, state.playing, state.liked, state.muted].join('|');
  if (!force && key === lastKey) return;
  lastKey = key;
  ipcRenderer.send('ew:state', state);
  updateMediaSession(state);
}

function updateMediaSession(state) {
  if (!('mediaSession' in navigator)) return;
  const metaKey = `${state.name}|${state.artist}|${state.cover}`;
  if (metaKey && metaKey !== lastMeta && state.name) {
    lastMeta = metaKey;
    try {
      navigator.mediaSession.metadata = new (window.MediaMetadata || function () {})({
        title: state.name,
        artist: state.artist || '闻曲',
        album: '闻曲 Earworm',
        artwork: state.cover ? [{ src: state.cover, sizes: '512x512' }] : [],
      });
    } catch { /* ignore */ }
  }
  try {
    navigator.mediaSession.playbackState = state.playing ? 'playing' : 'paused';
    if (state.duration > 0 && state.position >= 0) {
      navigator.mediaSession.setPositionState({
        duration: state.duration,
        position: Math.min(state.position, state.duration),
        playbackRate: 1,
      });
    }
  } catch { /* ignore */ }
}

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const handlers = {
    play: () => clickIfPaused(true),
    pause: () => clickIfPaused(false),
    previoustrack: () => click('prev'),
    nexttrack: () => click('next'),
    seekto: (d) => seekTo(d.seekTime),
  };
  Object.keys(handlers).forEach((name) => {
    try { navigator.mediaSession.setActionHandler(name, handlers[name]); } catch { /* ignore */ }
  });
}

function clickIfPaused(desiredPlaying) {
  const audio = $('audio');
  if (!audio) return;
  const playing = !audio.paused;
  if (playing !== desiredPlaying) click('mini-toggle');
}

function click(id) {
  const el = $(id);
  if (el) el.click();
}

function seekTo(seconds) {
  const audio = $('audio');
  if (audio && Number.isFinite(seconds)) audio.currentTime = Math.max(0, seconds);
}

function seekRatio(ratio) {
  const audio = $('audio');
  if (!audio || !Number.isFinite(ratio)) return;
  if (audio.duration > 0) audio.currentTime = audio.duration * Math.min(1, Math.max(0, ratio));
}

function setVolume(next) {
  const audio = $('audio');
  if (!audio) return;
  audio.muted = false;
  audio.volume = Math.min(1, Math.max(0, next));
  const slider = $('bar-vol');
  if (slider) {
    slider.value = Math.round(audio.volume * 100);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  }
  try { localStorage.setItem('ew_vol', String(audio.volume)); } catch { /* ignore */ }
  pushState(true);
}

function openPreferences() {
  const btn = $('tr-settings');
  if (btn && btn.offsetParent !== null) { btn.click(); return; }
  const modal = $('taste-modal');
  if (modal) {
    modal.hidden = false;
    document.body.classList.add('modal-open');
  }
}

/* ---------- 4. 接收主进程指令 ---------- */
ipcRenderer.on('ew:command', (_event, payload) => {
  const { cmd } = payload || {};
  const audio = $('audio');
  switch (cmd) {
    case 'toggle': click('mini-toggle'); break;
    case 'prev': click('prev'); break;
    case 'next': click('next'); break;
    case 'like': click('mini-like'); break;
    case 'queue': click('queue-btn'); break;
    case 'nav-home': click('nav-home'); break;
    case 'nav-mine': click('nav-mine'); break;
    case 'focus-search': {
      const pill = $('search-pill');
      if (pill) pill.click();
      const input = $('search-input');
      if (input) setTimeout(() => input.focus(), 60);
      break;
    }
    case 'open-preferences': openPreferences(); break;
    case 'volume-up': if (audio) setVolume(audio.volume + 0.06); break;
    case 'volume-down': if (audio) setVolume(audio.volume - 0.06); break;
    case 'mute': if (audio) { audio.muted = !audio.muted; pushState(true); } break;
    case 'seek-ratio': seekRatio(payload); break;
    default: break;
  }
});

/* ---------- 5. 生命周期钩子 ---------- */
window.addEventListener('DOMContentLoaded', () => {
  injectChrome();

  const audio = $('audio');
  if (audio) {
    ['play', 'pause', 'ended', 'loadedmetadata', 'volumechange'].forEach((evt) => {
      audio.addEventListener(evt, () => pushState(true));
    });
  }
  // 曲目信息、喜欢状态都靠 DOM 变化捕获，避免触碰 app.js 的闭包状态
  const observer = new MutationObserver(() => pushState(false));
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['src', 'class'],
  });

  setupMediaSession();

  // 进度不需要每次都过 MutationObserver，稳定 1s 一次
  setInterval(() => pushState(true), 1000);
  pushState(true);

  document.addEventListener('fullscreenchange', () => {
    document.documentElement.classList.toggle('ew-fullscreen', !!document.fullscreenElement);
  });
});
