'use strict';
/**
 * 拖动链路测试：在真实 Electron 里跑一遍完整拖动路径。
 *   node_modules\electron\dist\electron.exe tools\drag-test.js
 *   npm run test:drag
 *
 * 覆盖两半：
 *   1. windows.js 的跟随循环（抓取偏移、吸附、异常兜底）
 *   2. ball.html 的页面判定：用 sendInputEvent 真的按一下、移一下、松一下，
 *      确认位移超过阈值时页面会发出 ball-drag-start / ball-drag-end
 *
 * 为什么这个测试存在：上一版拖动走的是 win.startWindowDrag()，而 Electron 43 根本没有
 * 这个 API（electron.d.ts 里没有、运行时 typeof 是 undefined）。旧冒烟测试断言的恰恰是
 * 「main.js 应调用 win.startWindowDrag()」—— 静态断言把一个跑不通的设计锁死了。
 * 之后又有两起「只有真跑才暴露」的问题，都已固化成这里的断言：
 *   - 抓取偏移放在模块变量上、被 stopFollowTimer() 清成 null → 定时器每拍抛未捕获异常；
 *   - 页面用 e.screenX 判定拖动阈值，而该环境下 screenX 恒为 0 → 阈值永远跨不过去、拖动完全没反应。
 *
 * 光标是注入的假光标：跟随循环唯一的外部输入就是「光标在哪」，注入后整条路径完全确定。
 * （用真实光标做断言必然 flaky —— 用户随手动一下鼠标就会让断言失效。）
 */
const { app, screen, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const windows = require(path.join(__dirname, '..', 'src', 'lib', 'windows.js'));

// 结果同时落盘：app.exit() 会直接掐掉进程，stdout 可能来不及刷新（实测丢过）
const REPORT = path.join(__dirname, '..', 'preview', 'drag-test-report.txt');

app.disableHardwareAcceleration();

// Electron 默认「所有窗口关闭就退出应用」：下面会先建探针窗口、再销毁它，
// 若不管这件事，测试会在窗口归零的瞬间自己退出（实测：1 秒就退了、exit 0、什么日志都没有）。
app.on('window-all-closed', () => { /* 测试期间故意不退出 */ });

// 定时器回调里的未捕获异常不会让脚本崩掉，只会弹一个模态对话框 —— 必须主动收集。
// 不收集的话，「代码每 8ms 崩一次」也能拿到全绿（2026-10-01 真实发生过）。
const uncaught = [];
process.on('uncaughtException', (err) => { uncaught.push(err); });

const results = [];
function check(name, fn) {
  try { fn(); results.push([name, true, '']); }
  catch (e) { results.push([name, false, e.message]); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  let moveEndFired = 0;
  let fakeCursor = { x: 500, y: 500 };

  windows.init({
    cursor: () => fakeCursor,
    log: (m) => console.log('[win] ' + m),
    // 与 main.js 里 onBallMoveEnd 的真实行为一致：吸附 → 移动 → 保存
    onBallMoveEnd: () => {
      moveEndFired++;
      const w = windows.getBall();
      if (!w) return;
      const next = windows.snapPosition();
      if (!next) return;
      const [x, y] = w.getPosition();
      if (next.x !== x || next.y !== y) w.setPosition(next.x, next.y);
    }
  });

  // ---- 1) 金丝雀：记录「旧方案」为什么不可用 ----
  const probe = new BrowserWindow({ width: 48, height: 48, x: 200, y: 200, frame: false, show: false });
  check('Electron 43 里确实没有 win.startWindowDrag（旧方案跑不通的根因）', () => {
    if (typeof probe.startWindowDrag !== 'undefined') {
      throw new Error('现在有 startWindowDrag 了：可以改回原生拖动（更省电、零延迟）');
    }
  });
  check('跟随拖动所需 API 都存在', () => {
    if (typeof probe.setPosition !== 'function') throw new Error('缺少 win.setPosition');
    if (typeof probe.getPosition !== 'function') throw new Error('缺少 win.getPosition');
    if (typeof screen.getCursorScreenPoint !== 'function') throw new Error('缺少 screen.getCursorScreenPoint');
  });
  probe.destroy();

  // ---- 2) 造悬浮球 ----
  const win = windows.createBall({ x: 300, y: 300 });
  check('createBall 返回了可用窗口', () => {
    if (!win || win.isDestroyed()) throw new Error('没拿到悬浮球窗口');
  });
  await wait(800);

  const work = screen.getPrimaryDisplay().workArea;
  const [bw, bh] = win.getSize();
  check('悬浮球落在屏幕内（可见）', () => {
    const [x, y] = win.getPosition();
    const hit = (x + bw > work.x) && (y + bh > work.y) && (x < work.x + work.width) && (y < work.y + work.height);
    if (!hit) throw new Error(`球在屏幕外: (${x},${y}) ${bw}x${bh}，工作区 ${JSON.stringify(work)}`);
  });

  // ---- 3) 靠边吸附 ----
  check('贴右边缘的位置会被吸附进工作区', () => {
    win.setPosition(work.x + work.width - 20, work.y + 300);
    windows.endFollowDrag();     // 触发吸附回调（等价于松手）
    const [x, y] = win.getPosition();
    const expectX = work.x + work.width - bw;
    if (x !== expectX) throw new Error(`x=${x}，期望 ${expectX}`);
    if (y !== work.y + 300) throw new Error(`y=${y}，期望 ${work.y + 300}`);
  });
  check('吸附回调恰好触发一次', () => {
    if (moveEndFired !== 1) throw new Error(`触发 ${moveEndFired} 次，期望 1 次`);
  });

  // ---- 4) 跟随循环（假光标，完全确定）----
  // 假光标先落在球中心（模拟抓住球心），偏移才是真实量级
  const [startX, startY] = win.getPosition();
  fakeCursor = { x: startX + 24, y: startY + 24 };

  check('beginFollowDrag() 能启动跟随', () => {
    if (windows.beginFollowDrag() !== true) throw new Error('beginFollowDrag 返回 false');
    if (!windows.isFollowing()) throw new Error('跟随定时器没起来');
  });

  const grabOffset = { x: fakeCursor.x - startX, y: fakeCursor.y - startY };
  const target = { x: 700, y: 500 };
  fakeCursor = { x: target.x + grabOffset.x, y: target.y + grabOffset.y };
  await wait(150);
  check('跟随循环把窗口移到光标对应位置（抓取偏移保持不变）', () => {
    const [x, y] = win.getPosition();
    if (x !== target.x || y !== target.y) throw new Error(`窗口在 (${x},${y})，期望 (${target.x},${target.y})`);
  });

  win.setPosition(work.x + 100, work.y + 100);
  await wait(150);
  check('把窗口挪开后，下一拍会被拉回光标对应位置', () => {
    const [x, y] = win.getPosition();
    if (x !== target.x || y !== target.y) throw new Error(`窗口在 (${x},${y})，期望 (${target.x},${target.y})`);
  });

  check('跟随过程中不触发吸附（拖动中途停顿不该被吸一下）', () => {
    if (moveEndFired !== 1) throw new Error(`吸附回调变成 ${moveEndFired} 次，跟随中不该吸附`);
  });

  // ---- 5) 松手 ----
  check('endFollowDrag() 停止跟随', () => {
    windows.endFollowDrag();
    if (windows.isFollowing()) throw new Error('跟随定时器没停');
  });
  check('松手再次触发吸附回调', () => {
    if (moveEndFired !== 2) throw new Error(`吸附回调 ${moveEndFired} 次，期望 2 次`);
  });
  check('位置是整数（setPosition 传小数会抛 conversion failure）', () => {
    const [x, y] = win.getPosition();
    if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error(`非整数: (${x},${y})`);
  });
  // 回归：有一版球窗口被系统"拉边框缩放"越拖越大（48→852），球元素居中布局，
  // 一放大球就相对窗口左上角跑偏，表现为「稍微拉远一点就有偏移」。尺寸必须纹丝不动。
  check('拖动期间球窗口尺寸不得被改动', () => {
    const [cw, ch] = win.getSize();
    if (cw !== 48 || ch !== 48) throw new Error(`球窗口尺寸变成 ${cw}x${ch}，期望 48x48`);
  });

  // ---- 6) 合成鼠标事件：覆盖「页面那一半」的拖动入口 ----
  // 上面几步都是直接调 windows.beginFollowDrag()，等于跳过了页面的阈值判定与 IPC。
  // 而「拖动不了」恰恰出在那半段（screenX 恒为 0），所以这里真的按一下、移一下、松一下。
  let startMsgs = 0, endMsgs = 0, gotGrab = null;
  const onStart = (_e, grab) => { startMsgs++; gotGrab = grab; windows.beginFollowDrag(grab); };  // 与 main.js 行为一致
  const onEnd = () => { endMsgs++; windows.endFollowDrag(); };
  ipcMain.on('ball-drag-start', onStart);
  ipcMain.on('ball-drag-end', onEnd);

  const [curX, curY] = win.getPosition();
  // sendInputEvent() 要求窗口处于 **focused** 状态（Electron 文档明确写了），否则事件会被直接丢弃。
  // 从 npm script 启动时焦点在控制台窗口上：不显式 focus 的话这一整段会静默失败
  // （本测试踩过：直接跑 electron.exe 全绿，npm run test:drag 六项全红）。
  win.show();
  win.focus();
  await wait(300);
  // 关键：让假光标在阈值跨过时**已经远离窗口** —— 这正是真实世界的失败场景
  // （Chromium 会合并 mousemove，第一条事件可能已在几百像素之外）。
  // 旧实现用「光标 − 窗口」反推抓取偏移，于是球永远吊在光标旁边几百像素处、被越推越远。
  fakeCursor = { x: curX + 200, y: curY + 200 };
  // 球元素在 48x48 窗口里居中，所以 (24,24) 落在球上；再移到 (40,24) 位移 16px > 阈值 5px
  win.webContents.sendInputEvent({ type: 'mouseDown', x: 24, y: 24, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 40, y: 24, button: 'left' });
  await wait(200);
  check('按住并移动超过阈值后，页面确实发出了「拖动开始」', () => {
    if (startMsgs !== 1) throw new Error(`收到 ${startMsgs} 次 ball-drag-start，期望 1 次`);
  });
  check('收到「拖动开始」后主进程进入跟随状态', () => {
    if (!windows.isFollowing()) throw new Error('没有进入跟随状态');
  });
  // 这是「球吊在光标旁几百像素处、被越推越远直到屏幕外」那个 bug 的回归断言
  check('页面把按下点当作抓取偏移传来', () => {
    if (!gotGrab) throw new Error('dragStart 没有带抓取偏移');
    if (gotGrab.x !== 24 || gotGrab.y !== 24) {
      throw new Error(`抓取偏移=(${gotGrab.x},${gotGrab.y})，期望按下点 (24,24)`);
    }
  });
  check('抓取偏移落在球窗口内（越界就会让球吊在光标旁边）', () => {
    const [ww, hh] = win.getSize();
    if (!(gotGrab.x >= 0 && gotGrab.x <= ww && gotGrab.y >= 0 && gotGrab.y <= hh)) {
      throw new Error(`抓取偏移 (${gotGrab.x},${gotGrab.y}) 超出窗口 ${ww}x${hh}`);
    }
  });
  check('球被按下点锚定：光标已跑远 200px，也要把按下点拉回光标下', () => {
    const [x, y] = win.getPosition();
    const expX = fakeCursor.x - gotGrab.x, expY = fakeCursor.y - gotGrab.y;
    if (x !== expX || y !== expY) {
      // 旧实现会留在原地，于是「光标 − 球窗口」=200 而不是按下点 24
      throw new Error(`球在 (${x},${y})，期望 (${expX},${expY})；光标相对球窗口=(${fakeCursor.x - x},${fakeCursor.y - y})`);
    }
  });
  // 继续移动光标：球必须一直跟过去，且按下点始终落在光标下
  fakeCursor = { x: 900, y: 700 };
  await wait(150);
  check('继续移动光标，球保持跟随（按下点始终在光标下）', () => {
    const [x, y] = win.getPosition();
    if (fakeCursor.x - x !== gotGrab.x || fakeCursor.y - y !== gotGrab.y) {
      throw new Error(`光标相对球窗口=(${fakeCursor.x - x},${fakeCursor.y - y})，期望=抓取偏移 (${gotGrab.x},${gotGrab.y})`);
    }
  });

  win.webContents.sendInputEvent({ type: 'mouseUp', x: 40, y: 24, button: 'left', clickCount: 1 });
  await wait(200);
  check('松开后页面确实发出了「拖动结束」', () => {
    if (endMsgs < 1) throw new Error(`收到 ${endMsgs} 次 ball-drag-end，期望至少 1 次`);
  });
  check('「拖动结束」后跟随停止', () => {
    if (windows.isFollowing()) throw new Error('跟随没有停止');
  });
  ipcMain.removeListener('ball-drag-start', onStart);
  ipcMain.removeListener('ball-drag-end', onEnd);

  // ---- 7) 右键菜单：页面必须把「弹原生菜单」交给主进程 ----
  // HTML 菜单宽 176px，而球窗口只有 48px，一定会被窗口边界裁掉 —— 回归点就在这里。
  let menuMsgs = 0;
  const onMenu = () => { menuMsgs++; };
  ipcMain.on('ball-context-menu', onMenu);
  win.focus();            // 同上：sendInputEvent 需要窗口 focused
  await wait(150);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: 24, y: 24, button: 'right', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: 24, y: 24, button: 'right', clickCount: 1 });
  await wait(250);
  check('右键会请求主进程弹原生菜单（HTML 菜单装不进 48px 窗口）', () => {
    if (menuMsgs < 1) throw new Error(`收到 ${menuMsgs} 次 ball-context-menu，期望至少 1 次`);
  });
  check('右键不应顺带触发拖动', () => {
    if (windows.isFollowing()) throw new Error('右键把拖动带起来了');
  });
  ipcMain.removeListener('ball-context-menu', onMenu);

  // ---- 8) 整轮不允许有未捕获异常 ----
  check('整轮测试没有未捕获异常（定时器里的异常会弹模态对话框）', () => {
    if (uncaught.length) {
      throw new Error(`${uncaught.length} 个未捕获异常，首个: ${(uncaught[0] && uncaught[0].stack) || uncaught[0]}`);
    }
  });

  // ---- 报告 ----
  let failed = 0;
  const lines = [];
  for (const [name, ok, msg] of results) {
    if (!ok) failed++;
    lines.push(`  ${ok ? '✅' : '❌'} ${name}${ok ? '' : ' → ' + msg}`);
  }
  const text = [`=== 拖动链路测试（${new Date().toLocaleString('zh-CN')}）===`, ...lines,
    failed ? `\n${failed} 项失败` : '\n全部通过'].join('\n');
  try {
    fs.mkdirSync(path.dirname(REPORT), { recursive: true });
    fs.writeFileSync(REPORT, text + '\n', 'utf8');
  } catch (_) { /* 报告写不出去也不能影响结论 */ }
  console.log('\n' + text);
  const code = failed ? 1 : 0;
  process.exitCode = code;
  setTimeout(() => app.exit(code), 300);
}).catch((e) => {
  console.error('测试异常:', (e && e.stack) || e);
  try { fs.writeFileSync(REPORT, '测试异常: ' + ((e && e.stack) || e) + '\n', 'utf8'); } catch (_) {}
  setTimeout(() => app.exit(1), 300);
});
