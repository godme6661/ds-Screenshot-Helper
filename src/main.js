'use strict';
/**
 * ds截图助手 · 主进程
 * ---------------------------------------------------------------
 * 只有一条主线：
 *   全局快捷键 / 悬浮球 → 框选截图 → 把图片送进 DeepSeek 网页输入框 → 把网页窗口弹到前台
 * 之后的问题输入、发送、对话全部在 DeepSeek 网页里由用户完成。
 * 本程序不再代填问题、不点发送、不抓回答（那些自动化才是超时/误发的来源）。
 */
const { app, ipcMain, globalShortcut, Notification, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

const configLib = require('./lib/config');
const webwin = require('./lib/webwin');
const windows = require('./lib/windows');
const icons = require('./lib/icons');

const APP_NAME = 'ds截图助手';
app.setName(APP_NAME);

let isQuitting = false;
let savePosTimer = null;
let shortcutState = { open: null, capture: null };

// 日志同时落盘到 logs\main.log。
// 应用平时是从桌面快捷方式启动的，看不到控制台 —— 出了问题只有日志文件能作证。
let logFile = null;
function log(msg) {
  console.log(`[main] ${msg}`);
  if (!logFile) return;
  try { fs.appendFileSync(logFile, `[${new Date().toLocaleTimeString('zh-CN')}] ${msg}\n`, 'utf8'); }
  catch (_) { /* 日志写不进去不影响运行 */ }
}

// ============ 单实例 ============
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 已有实例在跑：把网页窗口亮出来
    openWeb();
  });
}

// ============ 全局快捷键（带冲突回退） ============
const CAPTURE_CANDIDATES = ['Alt+A', 'Alt+Shift+D', 'CommandOrControl+Shift+A'];
const OPEN_CANDIDATES = ['Alt+Q', 'Alt+D', 'CommandOrControl+Shift+D'];

function tryRegister(candidates, handler) {
  for (const acc of candidates) {
    if (!acc) continue;
    try { if (globalShortcut.register(acc, handler)) return acc; } catch (_) { /* 非法组合，试下一个 */ }
  }
  return null;
}

function registerShortcuts() {
  const cfg = configLib.get();
  shortcutState.capture = tryRegister([cfg.shortcutCapture, ...CAPTURE_CANDIDATES], () => captureAndSend());
  shortcutState.open = tryRegister([cfg.shortcutOpen, ...OPEN_CANDIDATES], () => openWeb());
  if (!shortcutState.capture) console.warn('截图的全局快捷键注册失败（可能被其他程序占用）');
  if (!shortcutState.open) console.warn('打开网页的全局快捷键注册失败（可能被其他程序占用）');
  log(`快捷键：截图=${shortcutState.capture || '未注册'} 打开网页=${shortcutState.open || '未注册'}`);
}

function reRegisterShortcuts() {
  globalShortcut.unregisterAll();
  registerShortcuts();
}

// ============ 开机自启 ============
function applyAutoLaunch(enabled) {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  try {
    const opts = { openAtLogin: !!enabled };
    if (!app.isPackaged) {
      opts.path = process.execPath;
      opts.args = [path.resolve(__dirname, '..')];
    }
    app.setLoginItemSettings(opts);
  } catch (err) {
    console.error('设置开机自启失败:', err.message);
  }
}

function autoLaunchEnabled() {
  try { return !!app.getLoginItemSettings().openAtLogin; } catch (_) { return false; }
}

// ============ 核心流程 ============
/** 打开 DeepSeek 网页窗口（并聚焦） */
function openWeb() {
  try {
    return webwin.showWindow({ icon: icons.appIcon(256) });
  } catch (err) {
    log(`打开网页失败：${err.message}`);
    return null;
  }
}

/** 触发框选截图 */
function captureAndSend() {
  windows.startCapture();
}

/** 框选完成后：把图片注入网页，并把网页窗口弹到前台 */
async function handleCapturedImage(imageDataURL) {
  if (!imageDataURL) return;
  try {
    const r = await webwin.sendScreenshot(imageDataURL, {
      icon: icons.appIcon(256),
      // 进度只进日志：球窗口只有 48px，页面里显示不了任何文字（状态气泡已删除）
      onProgress: (msg) => log(msg)
    });
    if (r && r.ok) {
      log('图片已送到网页');
    } else {
      const msg = (r && r.reason) || '送图失败';
      log(`送图失败：${msg}`);
      showNotification('ds截图助手', msg);
    }
  } catch (err) {
    log(`送图异常：${err.stack || err.message}`);
    showNotification('ds截图助手', `送图出错：${err.message}`);
  }
}

function showNotification(title, body) {
  try {
    if (!Notification.isSupported()) return;
    new Notification({ title, body }).show();
  } catch (_) { /* 忽略 */ }
}

// ============ 工具 ============
function fromWindow(event, getter) {
  const target = getter();
  return !!target && !target.isDestroyed() && event.sender === target.webContents;
}

function saveBallPos() {
  clearTimeout(savePosTimer);
  savePosTimer = setTimeout(() => {
    savePosTimer = null;
    const pos = windows.ballPosition();
    if (pos) configLib.set({ floatballPos: pos });
  }, 600);
}

function flushBallPos() {
  clearTimeout(savePosTimer);
  savePosTimer = null;
  const pos = windows.ballPosition();
  if (pos) configLib.set({ floatballPos: pos });
}

// ============ 菜单（悬浮球右键 / 托盘右键共用一份）============
/** 两处右键共用同一份菜单项，避免写法漂移 */
function appMenuItems() {
  return [
    { label: '截图并送到网页', accelerator: 'Alt+A', click: () => captureAndSend() },
    { label: '打开 DeepSeek 网页', accelerator: 'Alt+Q', click: () => openWeb() },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } }
  ];
}

// ============ IPC：悬浮球 ============
ipcMain.on('start-capture', () => captureAndSend());
ipcMain.on('open-web', () => openWeb());
ipcMain.on('quit-app', () => { isQuitting = true; app.quit(); });

// 右键 → 弹**原生菜单**。球窗口只有 48x48，HTML 菜单（176x120）会被窗口边界裁掉，
// 只有原生 Menu.popup() 能画到窗口外面去。
ipcMain.on('ball-context-menu', (event) => {
  const win = windows.getBall();
  if (!win || event.sender !== win.webContents) return;
  Menu.buildFromTemplate(appMenuItems()).popup({ window: win });
});

// 悬浮球拖动：renderer 只在按下 / 松开时各发一次 IPC，移动窗口由主进程轮询光标完成。
// 走过的三条死路（都别再回去）：
//   1. CSS 的 -webkit-app-region: drag —— Windows 上吞掉页面鼠标事件，单击/右键收不到，球点不动；
//   2. win.startWindowDrag() —— Electron 43 根本没有这个 API（electron.d.ts 里没有、运行时
//      typeof 是 undefined）。这是"拖动不了"的直接原因；
//   3. renderer 每帧 IPC 调 setPosition —— 跨进程往返在队列里累积延迟，表现是"球不跟鼠标"。
ipcMain.on('ball-drag-start', (event, grab) => {
  const win = windows.getBall();
  if (!win || event.sender !== win.webContents) return;
  log(`收到「拖动开始」抓取偏移=(${grab && grab.x},${grab && grab.y})`);
  windows.beginFollowDrag(grab);
});

ipcMain.on('ball-drag-end', (event) => {
  const win = windows.getBall();
  if (!win || event.sender !== win.webContents) return;
  log('收到「拖动结束」');
  windows.endFollowDrag();
});

// ============ IPC：截图 ============
ipcMain.on('capture-done', (event, payload) => {
  if (!fromWindow(event, windows.getCapture)) return;
  const imageDataURL = payload && payload.imageDataURL;
  windows.closeCapture();
  if (imageDataURL) handleCapturedImage(imageDataURL);
});

ipcMain.on('capture-cancel', (event) => {
  if (!fromWindow(event, windows.getCapture)) return;
  windows.closeCapture();
});

ipcMain.on('capture-error', (event, msg) => {
  if (!fromWindow(event, windows.getCapture)) return;
  windows.closeCapture();
  log(`截图失败：${msg}`);
  showNotification('ds截图助手', `截图失败：${msg}`);
});

// ============ 生命周期 ============
app.whenReady().then(() => {
  app.setAppUserModelId('com.ds.screenshot.assistant');
  configLib.init(app.getPath('userData'));
  // 过程日志落盘：出问题时可把整个 logs 目录发出来定位
  const logDir = path.join(app.getPath('userData'), 'logs');
  webwin.setLogFile(logDir);
  try {
    fs.mkdirSync(logDir, { recursive: true });
    logFile = path.join(logDir, 'main.log');
  } catch (_) { /* 落盘失败就只打控制台 */ }
  log(`===== 启动 ${new Date().toLocaleString('zh-CN')} =====`);

  const cfg = configLib.get();
  const cleaned = webwin.cleanupStaleTempFiles();
  if (cleaned) log(`已清理 ${cleaned} 个历史临时截图文件`);

  if (!!cfg.launchAtLogin !== autoLaunchEnabled()) applyAutoLaunch(cfg.launchAtLogin);

  windows.init({
    appIcon: () => icons.appIcon(256),
    // windows.js 里的拖动诊断走这条 logger 落进日志文件
    log: (m) => log(m),
    // 拖动结束：靠边吸附并保存位置
    onBallMoveEnd: () => {
      const win = windows.getBall();
      if (!win) return;
      const next = windows.snapPosition();
      if (next) {
        const [x, y] = win.getPosition();
        if (next.x !== x || next.y !== y) win.setPosition(next.x, next.y);
      }
      flushBallPos();
    }
  });
  windows.createBall(cfg.floatballPos);
  // 把悬浮球页面里的 console 转进日志：从快捷方式启动时根本看不到 DevTools，
  // 拖动这类"只在页面上发生"的问题否则完全无法取证。
  const ball = windows.getBall();
  if (ball) {
    ball.webContents.on('console-message', (...args) => {
      const first = args[0];
      const msg = (first && typeof first === 'object' && typeof first.message === 'string')
        ? first.message
        : args[2];
      if (msg) log(`[球] ${msg}`);
    });
  }
  windows.createTray({
    icon: icons.trayIcon(),
    menuTemplate: appMenuItems(),   // 与悬浮球右键同一份菜单
    onCapture: () => captureAndSend(),
    onOpenWeb: () => openWeb()
  });

  registerShortcuts();
  log('启动完成');
});

app.on('before-quit', () => {
  isQuitting = true;
  flushBallPos();
  webwin.cleanupTempFiles();
  windows.destroyTray();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (isQuitting && process.platform !== 'darwin') app.quit();
});

app.on('activate', () => openWeb());

module.exports = {};
