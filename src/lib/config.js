'use strict';
/**
 * 配置持久化：settings.json（Electron userData 目录）
 * 精简版：只保留「怎么触发截图」和「窗口/开机行为」。
 * 不再有提问模板、自动发送、历史容量等设置——问题在网页里由用户自己输入。
 * 设计原则：所有读取都容错，损坏的配置回退默认值，绝不让应用启动失败。
 */
const fs = require('fs');
const path = require('path');

let filePath = null;

const DEFAULTS = {
  version: 2,
  // 触发方式
  shortcutCapture: 'Alt+A',       // 截图并送到网页
  shortcutOpen: 'Alt+Q',          // 只打开 DeepSeek 网页窗口
  // 系统
  launchAtLogin: false,
  closeToTray: false,             // 关闭网页窗口时隐藏而不是退出（托盘仍在）
  // 窗口位置
  floatballPos: null,
  webBounds: null                 // 网页窗口位置尺寸（退出时记录）
};

let config = { ...DEFAULTS };
let listeners = [];

function init(userDataDir) {
  filePath = path.join(userDataDir, 'settings.json');
  load();
  return config;
}

function load() {
  try {
    if (filePath && fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      config = merge(DEFAULTS, raw);
      // 旧版本（v1 = 带提问模板/历史/自动抓回答的那套）留下的字段会被 merge 过滤掉，
      // 这里显式把文件重写成新 schema，免得旧键一直留在磁盘上。
      if (Number(raw.version) !== DEFAULTS.version) {
        console.log(`配置从 v${raw.version || 1} 迁移到 v${DEFAULTS.version}，已丢弃不再使用的字段`);
        save();
      }
    }
  } catch (err) {
    console.error('读取配置失败，使用默认配置:', err.message);
    config = { ...DEFAULTS };
  }
}

function merge(base, patch) {
  const out = { ...base };
  for (const key of Object.keys(base)) {
    if (!(key in patch)) continue;
    const bv = base[key];
    const pv = patch[key];
    // 版本号永远以当前代码为准，否则旧文件里的 version 会盖回去、每次都重复迁移
    if (key === 'version') continue;
    // 两个坐标对象：只在结构完整合法时接受。
    // 早期版本把 null 直接传下去并解构，导致启动崩溃，这里必须守住。
    if (key === 'floatballPos' || key === 'webBounds') {
      if (pv && typeof pv === 'object') {
        const need = key === 'floatballPos' ? ['x', 'y'] : ['x', 'y', 'width', 'height'];
        if (need.every((k) => Number.isFinite(pv[k]))) {
          const o = {};
          need.forEach((k) => { o[k] = Math.round(pv[k]); });
          out[key] = o;
        }
      }
      continue;
    }
    if (typeof bv === typeof pv) out[key] = pv;
  }
  return out;
}

function get() { return config; }
function getPath() { return filePath; }

function set(patch) {
  config = merge(config, patch);
  save();
  const snapshot = get();
  listeners.forEach((fn) => { try { fn(snapshot); } catch (err) { console.error('配置监听回调出错:', err.message); } });
  return snapshot;
}

function reset() {
  config = { ...DEFAULTS };
  save();
  return get();
}

function save() {
  if (!filePath) return;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // 原子写：先写临时文件再重命名，避免强退留下半截 JSON
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    console.error('写入配置失败:', err.message);
  }
}

function onChange(fn) {
  listeners.push(fn);
  return () => { listeners = listeners.filter((f) => f !== fn); };
}

module.exports = { init, get, getPath, set, reset, onChange, DEFAULTS };
