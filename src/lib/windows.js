'use strict';
/**
 * 窗口管理：悬浮球 / 截图遮罩 / 托盘
 * 精简版：已删除对话框窗口——问题在 DeepSeek 网页里由用户自己输入。
 */
const { BrowserWindow, screen, Menu, Tray, nativeImage } = require('electron');
const path = require('path');
const { captureScreensData } = require('./capture');
const { resolveFloatballPosition, snapToEdges, grabOffset, followPosition, FLOATBALL_SIZE } = require('./geometry');

const SRC = path.join(__dirname, '..');
const PRELOAD = path.join(SRC, 'preload.js');
const BALL_PAGE = 'ball.html';
const CAPTURE_PAGE = 'capture.html';

let ballWin = null;
let captureWin = null;
let tray = null;
let callbacks = {};
let followTimer = null;
let followTicks = 0;
let followMoves = 0;
// 光标来源可注入：跟随循环唯一的外部输入就是"光标在哪"，
// 注入之后测试就能完全控制它（真实光标随时会被用户移动，拿它做断言必然 flaky）。
let cursorSource = null;

// 跟随轮询间隔：~120Hz。跟手足够，又不会像逐帧 IPC 那样把请求堆在队列里。
const FOLLOW_INTERVAL_MS = 8;
// 兜底：一次拖动不可能持续这么久。真的超时说明「松手」事件丢了（球会一直粘着鼠标），
// 这时宁可停掉跟随。注意**不要**用「光标离开窗口」判定松手 —— 按住拖动时页面有隐式鼠标捕获，
// 光标本来就可能落在窗口之外（日志实证：client 坐标能到 714，而球窗口只有 48px）。
const FOLLOW_MAX_MS = 60000;

/** 诊断日志：走 main.js 注入的 logger，这样能落进日志文件 */
function wlog(msg) {
  if (!callbacks.log) return;
  try { callbacks.log(msg); } catch (_) { /* 日志失败不影响运行 */ }
}

function init(cb) {
  callbacks = cb || {};
  cursorSource = (callbacks && typeof callbacks.cursor === 'function') ? callbacks.cursor : null;
}

/** 当前光标位置（逻辑像素）；测试可注入假的 */
function getCursor() {
  return cursorSource ? cursorSource() : screen.getCursorScreenPoint();
}

// ============ 悬浮球 ============
// pos 可能为 null（首次运行）或来自损坏的配置 → 必须容错，不能直接解构
function createBall(pos) {
  if (ballWin && !ballWin.isDestroyed()) return ballWin;
  let display = screen.getPrimaryDisplay() || screen.getAllDisplays()[0] || null;
  // 存下的坐标可能落在副屏上（多屏）：用「离该点最近的显示器」当夹取边界，
  // 副屏上的球才不会被拽回主屏；坐标完全在所有屏幕之外时，
  // getDisplayNearestPoint 会给出最近的屏幕，resolveFloatballPosition 再把坐标夹进它的工作区。
  if (pos && typeof pos === 'object' && Number.isFinite(Number(pos.x)) && Number.isFinite(Number(pos.y))) {
    const near = screen.getDisplayNearestPoint({ x: Number(pos.x), y: Number(pos.y) });
    if (near) display = near;
  }
  const { x, y } = resolveFloatballPosition(pos, display && display.workArea);
  ballWin = new BrowserWindow({
    width: FLOATBALL_SIZE,
    height: FLOATBALL_SIZE,
    x,
    y,
    transparent: true,
    frame: false,
    // thickFrame 默认是 true —— 在 Windows 上会给 frameless 窗口加上 WS_THICKFRAME 调整边框。
    // 球几乎填满 48px 窗口，于是"贴着球边缘按下"会被系统当成拉边框缩放：
    // 窗口被越拖越大（日志实证 48 → 640 → … → 852），球元素又是居中布局，
    // 一放大球就相对窗口左上角往外跑，表现为"稍微拉远一点就有偏移"。
    thickFrame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    title: 'ds截图助手',
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false }
  });
  ballWin.loadFile(path.join(SRC, BALL_PAGE));
  ballWin.setAlwaysOnTop(true, 'floating');
  ballWin.setVisibleOnAllWorkspaces(true);
  ballWin.on('closed', () => { stopFollowTimer(); ballWin = null; });

  // 诊断：窗口尺寸被改动时记一笔（节流到 500ms 一条，避免被系统连续缩放时刷屏）。
  // 正常情况**不该出现**这行日志；出现了就说明有东西在改球窗口大小。
  let lastResizeLog = 0;
  ballWin.on('resize', () => {
    const w = ballWin;
    if (!w || w.isDestroyed()) return;
    const now = Date.now();
    if (now - lastResizeLog < 500) return;
    lastResizeLog = now;
    const [cw, ch] = w.getSize();
    wlog(`球窗口被 resize → ${cw}x${ch}（期望 ${FLOATBALL_SIZE}x${FLOATBALL_SIZE}）`);
  });
  return ballWin;
}

function runMoveEnd() {
  if (!callbacks.onBallMoveEnd) return;
  try { callbacks.onBallMoveEnd(); } catch (err) { console.error('拖动结束回调出错:', err.message); }
}

function stopFollowTimer() {
  if (followTimer) { clearInterval(followTimer); followTimer = null; }
}

function isFollowing() { return !!followTimer; }

/**
 * 开始「跟随鼠标」拖动：由**主进程**轮询光标并移动窗口。
 *
 * 为什么是这套写法（三条路都试过，只有这条能跑）：
 *   1. CSS 的 -webkit-app-region: drag —— Windows 上会吞掉页面鼠标事件，
 *      单击/右键都收不到，球会点不动（真实踩过，见 handoff）；
 *   2. win.startWindowDrag() —— Electron 43 **根本没有这个 API**：electron.d.ts 里
 *      没有它，运行时 typeof 也是 undefined。这是「拖动不了」的直接原因；
 *      而当时的冒烟测试断言的恰恰是「调用了 startWindowDrag」，等于把死路锁死了；
 *   3. renderer 每帧 IPC 调 setPosition —— 跨进程往返会在队列里累积延迟，
 *      表现就是「球不跟鼠标」。
 * 现在 renderer 只在按下/松开各发一次 IPC，跟随全在主进程完成：既跟手，也不会堆积。
 *
 * @param {{x:number,y:number}} [grab] 抓取偏移 = **按下点**（球窗口内坐标），由页面在 mousedown 时给出。
 *   绝不能由主进程用「光标 − 窗口」反推：快速拖动时 Chromium 会合并 mousemove，
 *   第一条事件可能已经在几百像素之外，反推的偏移会让球永远吊在光标旁边几百像素处，
 *   还会被越推越远直到屏幕外（2026-10-01 日志实证：偏移一路从 184 涨到 714，而窗口只有 48px）。
 */
function beginFollowDrag(grab) {
  const win = getBall();
  if (!win) return false;
  stopFollowTimer();
  const [wx, wy] = win.getPosition();
  const [ww, hh] = win.getSize();
  const cursor = getCursor();
  let sizeFixedLogged = false;
  const usable = !!(grab && Number.isFinite(grab.x) && Number.isFinite(grab.y)
    && grab.x >= 0 && grab.x <= ww && grab.y >= 0 && grab.y <= hh);
  // 抓取偏移**捕获进闭包**，不放模块变量：放模块变量会被 stopFollowTimer() 清成 null，
  // 定时器下一拍就在 followPosition 里抛 "Cannot read properties of null (reading 'x')"，
  // 而定时器里的未捕获异常会弹 Electron 报错框并把应用带走（2026-10-01 真实发生过）。
  const offset = usable
    ? { x: Math.round(grab.x), y: Math.round(grab.y) }
    : grabOffset(cursor, { x: wx, y: wy });
  followTicks = 0;
  followMoves = 0;
  wlog(`拖动开始：抓取偏移=(${offset.x},${offset.y})${usable ? '（按下点）' : '（回退=光标−窗口）'}`
    + ` 窗口=(${wx},${wy}) ${ww}x${hh} 光标=(${cursor.x},${cursor.y})`);
  const startedAt = Date.now();
  followTimer = setInterval(() => {
    // 整个循环包 try/catch：定时器里漏出的异常会变成模态对话框，比停掉跟随糟糕得多
    try {
      const w = getBall();
      if (!w) { stopFollowTimer(); return; }
      if (Date.now() - startedAt > FOLLOW_MAX_MS) {
        wlog(`跟随已持续 ${Math.round((Date.now() - startedAt) / 1000)}s，按「松手事件丢失」处理，停止跟随`);
        stopFollowTimer();
        return;
      }
      followTicks++;
      const cur = getCursor();
      const next = followPosition(cur, offset);
      const [x, y] = w.getPosition();
      const [cw, ch] = w.getSize();
      if (cw !== FLOATBALL_SIZE || ch !== FLOATBALL_SIZE) {
        // 尺寸被外部改动了（见 createBall 里 thickFrame 的说明）：连同位置一起钉回 48x48。
        // 这是自愈兜底 —— 只要窗口尺寸一被改动，下一拍就恢复，球不会再相对光标跑偏。
        w.setBounds({ x: next.x, y: next.y, width: FLOATBALL_SIZE, height: FLOATBALL_SIZE });
        if (!sizeFixedLogged) {
          sizeFixedLogged = true;
          wlog(`跟随中窗口尺寸被改成 ${cw}x${ch}，已钉回 ${FLOATBALL_SIZE}x${FLOATBALL_SIZE}`);
        }
        followMoves++;
        return;
      }
      if (next.x === x && next.y === y) return;
      w.setPosition(next.x, next.y);
      followMoves++;
    } catch (err) {
      console.error('跟随拖动失败:', err.message);
      stopFollowTimer();
    }
  }, FOLLOW_INTERVAL_MS);
  return true;
}

/** 结束跟随拖动：停表 → 吸附 + 保存位置（由 main.js 提供的 onBallMoveEnd 完成） */
function endFollowDrag() {
  const ticks = followTicks, moves = followMoves;
  stopFollowTimer();
  wlog(`拖动结束：跟随 ${ticks} 拍，实际移动窗口 ${moves} 次`);
  runMoveEnd();
}

function getBall() {
  return (ballWin && !ballWin.isDestroyed()) ? ballWin : null;
}

function ballPosition() {
  const win = getBall();
  if (!win) return null;
  const [x, y] = win.getPosition();
  return { x, y };
}

/** 靠边吸附：返回吸附后的位置（不直接移动窗口，便于测试）
 *  按**光标所在屏幕**计算——拖动结束后光标位置比窗口中心更可靠（多屏时尤其明显） */
function snapPosition() {
  const win = getBall();
  if (!win) return null;
  const [x, y] = win.getPosition();
  const [w, h] = win.getSize();
  let display = null;
  try {
    const pt = getCursor();
    display = screen.getDisplayNearestPoint(pt) || null;
  } catch (_) { /* 取不到光标就退回窗口中心 */ }
  if (!display) {
    display = screen.getDisplayNearestPoint({ x: x + Math.round(w / 2), y: y + Math.round(h / 2) })
      || screen.getPrimaryDisplay();
  }
  if (!display || !display.workArea) return null;
  return snapToEdges({ x, y }, { width: w, height: h }, display.workArea);
}

// ============ 截图遮罩 ============
function getCapture() {
  return (captureWin && !captureWin.isDestroyed()) ? captureWin : null;
}

async function startCapture() {
  if (getCapture()) return false; // 已在截图流程中（快捷键连按）

  // 截图时把悬浮球藏起来，免得被拍进去
  const ball = getBall();
  if (ball) ball.hide();

  try {
    const data = await captureScreensData();
    captureWin = new BrowserWindow({
      x: data.totalBounds.x,
      y: data.totalBounds.y,
      width: data.totalBounds.width,
      height: data.totalBounds.height,
      transparent: false,
      frame: false,
      alwaysOnTop: true,
      resizable: false,
      hasShadow: false,
      skipTaskbar: true,
      movable: false,
      minimizable: false,
      fullscreenable: false,
      enableLargerThanScreen: true,
      title: 'ds截图助手 · 框选截图',
      webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false }
    });
    captureWin.setAlwaysOnTop(true, 'screen-saver');
    captureWin.setBounds(data.totalBounds);
    captureWin.loadFile(path.join(SRC, CAPTURE_PAGE));
    captureWin.webContents.on('did-finish-load', () => {
      const win = getCapture();
      if (win) win.webContents.send('capture-screen', data);
    });
    captureWin.on('closed', () => {
      captureWin = null;
      const b = getBall();
      if (b) b.show();
    });
    return true;
  } catch (err) {
    console.error('截图失败:', err);
    captureWin = null;
    const b = getBall();
    if (b) b.show();
    // 窗口里显示不了文字，失败原因写进日志（main.js 注入的 logger → logs\main.log）
    wlog(`截图失败：${err.message}`);
    return false;
  }
}

function closeCapture() {
  const win = getCapture();
  if (win) {
    captureWin = null;
    win.close();
  }
}

// ============ 托盘 ============
/** menuTemplate 由 main.js 提供（与悬浮球右键共用）；未提供时按回调现搭一份 */
function createTray({ icon, menuTemplate, onCapture, onOpenWeb, onQuit }) {
  if (tray && !tray.isDestroyed()) return tray;
  let img = icon;
  if (typeof img === 'string') img = nativeImage.createFromPath(img);
  if (!img || img.isEmpty()) return null;
  try {
    tray = new Tray(img);
  } catch (err) {
    console.error('创建托盘失败:', err.message);
    return null;
  }
  const template = (Array.isArray(menuTemplate) && menuTemplate.length)
    ? menuTemplate
    : [
      { label: '截图并送到网页', click: onCapture },
      { label: '打开 DeepSeek 网页', click: onOpenWeb },
      { type: 'separator' },
      { label: '退出', click: onQuit }
    ];
  const menu = Menu.buildFromTemplate(template);
  tray.setToolTip('ds截图助手 · 截图即送到网页');
  tray.setContextMenu(menu);
  tray.on('click', onCapture);
  tray.on('double-click', onOpenWeb);
  return tray;
}

function getTray() {
  return (tray && !tray.isDestroyed()) ? tray : null;
}

function destroyTray() {
  const t = getTray();
  if (t) { t.destroy(); tray = null; }
}

module.exports = {
  init,
  createBall,
  getBall,
  ballPosition,
  snapPosition,
  beginFollowDrag,
  endFollowDrag,
  isFollowing,
  getCapture,
  startCapture,
  closeCapture,
  createTray,
  getTray,
  destroyTray
};
