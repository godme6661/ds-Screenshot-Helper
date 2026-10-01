'use strict';
/**
 * 图标：优先读取 build/ 目录下由 tools/gen-icons.js 生成的 PNG，
 * 缺失时回退到内联绘制（保证任何情况下都有图标可用，不出现空白托盘）。
 */
const { nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const BUILD_DIR = path.join(__dirname, '..', '..', 'build');
const cache = new Map();

function loadPng(name) {
  if (cache.has(name)) return cache.get(name);
  const p = path.join(BUILD_DIR, name);
  let img = null;
  try {
    if (fs.existsSync(p)) img = nativeImage.createFromPath(p);
  } catch (err) {
    console.error(`读取图标 ${name} 失败:`, err.message);
  }
  cache.set(name, img && !img.isEmpty() ? img : null);
  return cache.get(name);
}

/** 运行时兜底：用窗口截图能力之外的纯色图形，保证不至于没有图标 */
function fallbackIcon(size = 32) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4A90D9"/><stop offset="1" stop-color="#6C5CE7"/>
    </linearGradient></defs>
    <rect x="1" y="1" width="30" height="30" rx="7" fill="url(#g)"/>
    <path d="M9 12V9h3M23 12V9h-3M9 20v3h3M23 20v3h-3" stroke="#fff" stroke-width="2.2"
      stroke-linecap="round" fill="none"/>
    <circle cx="16" cy="16" r="2.6" fill="#fff"/>
  </svg>`;
  try {
    return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
  } catch (err) {
    console.error('生成兜底图标失败:', err.message);
    return nativeImage.createEmpty();
  }
}

/** 应用图标（窗口 / 任务栏 / 打包），size 仅作提示，实际用最大的可用图 */
function appIcon(size = 256) {
  const candidate = size >= 256 ? 'icon.png' : `icon-${size}.png`;
  return loadPng(candidate) || loadPng('icon.png') || loadPng('icon-512.png') || fallbackIcon(size);
}

/** 托盘图标：浅色系统用深色图形，深色系统用白色图形 */
function trayIcon({ dark } = {}) {
  let isDark = dark;
  if (typeof isDark !== 'boolean') {
    try {
      const { nativeTheme } = require('electron');
      isDark = nativeTheme.shouldUseDarkColors;
    } catch (_) {
      isDark = true;
    }
  }
  if (isDark) return loadPng('tray.png') || fallbackIcon(32);
  return loadPng('tray-dark.png') || loadPng('tray.png') || fallbackIcon(32);
}

function iconPath() {
  const p = path.join(BUILD_DIR, 'icon.png');
  return fs.existsSync(p) ? p : null;
}

module.exports = { appIcon, trayIcon, iconPath, BUILD_DIR };
