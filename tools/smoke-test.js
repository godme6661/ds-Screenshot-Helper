'use strict';
/**
 * 无 UI 冒烟测试：配置读写/容错、悬浮球几何、源码一致性、图标资源。
 *   node tools/smoke-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (err) {
    fail++;
    console.log('  ✗ ' + name + ' → ' + err.message);
  }
}

/**
 * 去掉注释后再做静态检查：注释里作为"反面教材"提到的禁用写法不是真实用法。
 * （ball.html 第 22 行的说明文字曾让下面那条"不能用 CSS 拖拽区"的断言误报。）
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')       // /* 块注释 */
    .replace(/^[ \t]*\/\/[^\n]*$/gm, '');   // 整行的 // 注释（不动行尾注释，避免误伤 URL）
}

console.log('【1】配置模块');
const config = require(path.join(ROOT, 'src/lib/config.js'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-cfg-'));

check('初始化后读取默认值', () => {
  const c = config.init(tmp);
  assert.strictEqual(c.shortcutCapture, 'Alt+A');
  assert.strictEqual(c.shortcutOpen, 'Alt+Q');
  assert.strictEqual(c.launchAtLogin, false);
  assert.strictEqual(c.floatballPos, null);
  assert.strictEqual(c.webBounds, null);
});

check('不再包含已删除的旧配置项', () => {
  const c = config.init(tmp);
  ['promptPreset', 'prompts', 'autoSend', 'followUp', 'historyLimit', 'solve'].forEach((k) => {
    assert.ok(!(k in c), `配置里不应再有 ${k}`);
  });
});

check('写入并落盘', () => {
  config.set({ shortcutCapture: 'Ctrl+Alt+S', launchAtLogin: true });
  const p = config.getPath();
  assert.ok(fs.existsSync(p), 'settings.json 应已生成');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.strictEqual(raw.shortcutCapture, 'Ctrl+Alt+S');
  assert.strictEqual(raw.launchAtLogin, true);
});

check('重新加载后保持修改', () => {
  config.init(tmp);
  assert.strictEqual(config.get().shortcutCapture, 'Ctrl+Alt+S');
  assert.strictEqual(config.get().launchAtLogin, true);
});

check('悬浮球坐标只在合法时接受', () => {
  config.set({ floatballPos: { x: 120, y: 240 } });
  assert.deepStrictEqual(config.get().floatballPos, { x: 120, y: 240 });
  config.set({ floatballPos: { x: 'abc', y: null } });
  assert.deepStrictEqual(config.get().floatballPos, { x: 120, y: 240 }, '非法坐标应被忽略');
  config.set({ floatballPos: null });
  assert.deepStrictEqual(config.get().floatballPos, { x: 120, y: 240 }, 'null 不应覆盖有效值');
});

check('webBounds 必须四个字段齐全才接受', () => {
  config.set({ webBounds: { x: 10, y: 20, width: 800, height: 600 } });
  assert.deepStrictEqual(config.get().webBounds, { x: 10, y: 20, width: 800, height: 600 });
  config.set({ webBounds: { x: 1, y: 2 } });
  assert.deepStrictEqual(config.get().webBounds, { x: 10, y: 20, width: 800, height: 600 }, '缺字段应被忽略');
});

check('类型不匹配的补丁被忽略', () => {
  config.set({ launchAtLogin: 'yes' });
  assert.strictEqual(config.get().launchAtLogin, true);
  assert.strictEqual(config.get().closeToTray, false);
});

check('配置文件损坏时回退默认值', () => {
  fs.writeFileSync(config.getPath(), '{ 这不是 json ', 'utf8');
  config.init(tmp);
  assert.strictEqual(config.get().shortcutCapture, 'Alt+A');
});

check('reset 恢复默认', () => {
  const c = config.reset();
  assert.deepStrictEqual(c, { ...config.DEFAULTS });
});

console.log('\n【2】几何模块（悬浮球位置/吸附）');
const geo = require(path.join(ROOT, 'src/lib/geometry.js'));
check('floatballPos 为 null 时不崩溃（回归：曾导致启动崩溃）', () => {
  const p = geo.resolveFloatballPosition(null, { width: 1536, height: 960 });
  assert.deepStrictEqual(p, { x: 1468, y: 892 });
});
check('undefined / 原始值 / 空对象 / 非法坐标都走默认位置', () => {
  const wa = { width: 1000, height: 800 };
  for (const bad of [undefined, null, '', 0, {}, { x: 'a', y: 'b' }, [], true]) {
    assert.deepStrictEqual(geo.resolveFloatballPosition(bad, wa), { x: 932, y: 732 }, `输入 ${JSON.stringify(bad)} 异常`);
  }
});
check('合法坐标被保留', () => {
  assert.deepStrictEqual(geo.resolveFloatballPosition({ x: 100, y: 200 }, { width: 1000, height: 800 }), { x: 100, y: 200 });
});
check('屏幕外的坐标回落到默认的右下角（回归：曾导致球在屏幕外启动，看不见也点不到）', () => {
  const wa = { x: 0, y: 0, width: 1536, height: 960 };
  const def = { x: 1536 - 48 - 20, y: 960 - 48 - 20 };
  // 2026-10-01 机器上实际存过的值 —— 当时球完全落在屏幕外
  assert.deepStrictEqual(geo.resolveFloatballPosition({ x: -111, y: -545 }, wa), def);
  assert.deepStrictEqual(geo.resolveFloatballPosition({ x: 99999, y: 99999 }, wa), def);
  // 副屏在主屏左侧（工作区原点为负）时，副屏上的合法坐标必须原样保留，不能被拽回主屏
  const waLeft = { x: -1920, y: 0, width: 1920, height: 1040 };
  assert.deepStrictEqual(geo.resolveFloatballPosition({ x: -1800, y: 300 }, waLeft), { x: -1800, y: 300 });
});
check('默认位置在右下角（用户要求：启动后默认出现在右下角）', () => {
  const wa = { x: 0, y: 0, width: 1536, height: 960 };
  assert.deepStrictEqual(geo.resolveFloatballPosition(null, wa), { x: 1468, y: 892 });
  assert.deepStrictEqual(geo.resolveFloatballPosition(undefined, wa), { x: 1468, y: 892 });
  // 有效但会露出屏幕 → 夹到「整颗球可见」
  assert.deepStrictEqual(geo.resolveFloatballPosition({ x: 1530, y: 950 }, wa), { x: 1488, y: 912 });
  assert.deepStrictEqual(geo.resolveFloatballPosition({ x: 100, y: 200 }, wa), { x: 100, y: 200 });
});
check('工作区缺失时回退安全默认值', () => {
  const p = geo.resolveFloatballPosition(null, null);
  assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.y >= 0);
});
check('靠边吸附：贴右边缘 / 中间不动 / 不越界', () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  const size = { width: 48, height: 48 };
  assert.deepStrictEqual(geo.snapToEdges({ x: 1862, y: 500 }, size, wa), { x: 1872, y: 500 });
  assert.deepStrictEqual(geo.snapToEdges({ x: 900, y: 500 }, size, wa), { x: 900, y: 500 });
  assert.deepStrictEqual(geo.snapToEdges({ x: 5000, y: 5000 }, size, { x: 0, y: 0, width: 800, height: 600 }), { x: 752, y: 552 });
});
check('吸附结果必须是整数（workArea 在小数缩放比下可能是小数）', () => {
  const size = { width: 48, height: 48 };
  const frac = geo.snapToEdges({ x: 5000, y: 5000 }, size, { x: 0, y: 0, width: 1228.8, height: 768.5 });
  // 实测：setPosition() 传小数会直接抛 "Error processing argument at index 0, conversion failure"
  assert.ok(Number.isInteger(frac.x) && Number.isInteger(frac.y), `吸附结果不是整数: ${JSON.stringify(frac)}`);
});
check('拖动跟随：抓取偏移与取整（纯函数）', () => {
  const off = geo.grabOffset({ x: 500, y: 400 }, { x: 480, y: 380 });
  assert.deepStrictEqual(off, { x: 20, y: 20 });
  // 跟随必须复用按下时算出的偏移，否则球会跳到鼠标正中心
  assert.deepStrictEqual(geo.followPosition({ x: 700, y: 600 }, off), { x: 680, y: 580 });
  // 必须取整：setPosition() 只接受整数
  assert.deepStrictEqual(geo.followPosition({ x: 700.6, y: 600.4 }, { x: 20.5, y: 20 }), { x: 680, y: 580 });
});
check('windows.js 走容错后的位置解析（不再直接解构）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/lib/windows.js'), 'utf8');
  assert.ok(src.includes('resolveFloatballPosition(pos'), '应调用 resolveFloatballPosition');
  assert.ok(!/function createBall\(\{ x, y \}/.test(src), '不应再对入参直接解构');
  // 必须把含原点的完整 workArea 交下去，否则副屏（负原点）上的坐标会被误判
  assert.ok(/display\s*&&\s*display\.workArea\b/.test(src), '应把完整 workArea（含原点）交给位置解析');
});

console.log('\n【3】源码一致性');
const SRC = path.join(ROOT, 'src');
const listFiles = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(p, out);
    else out.push(p);
  }
  return out;
};
const srcFiles = listFiles(SRC);

check('HTML 里调用的 electronAPI 方法都在 preload 中暴露', () => {
  const preload = fs.readFileSync(path.join(SRC, 'preload.js'), 'utf8');
  const exposed = new Set([...preload.matchAll(/^\s{2}([a-zA-Z][\w]*):/gm)].map((m) => m[1]));
  const missing = [];
  for (const f of srcFiles.filter((p) => p.endsWith('.html'))) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/electronAPI\??\.([a-zA-Z][\w]*)/g)) {
      if (!exposed.has(m[1])) missing.push(`${path.basename(f)}: ${m[1]}`);
    }
  }
  assert.deepStrictEqual(missing, [], '未暴露的 API: ' + missing.join(', '));
});

check('preload 调用的 IPC 通道都由主进程注册', () => {
  const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(SRC, 'preload.js'), 'utf8');
  const handled = new Set([...main.matchAll(/ipcMain\.(?:on|handle)\('([^']+)'/g)].map((m) => m[1]));
  const used = [...preload.matchAll(/ipcRenderer\.(?:send|invoke)\('([^']+)'/g)].map((m) => m[1]);
  const missing = used.filter((c) => !handled.has(c));
  assert.deepStrictEqual(missing, [], '主进程未注册: ' + missing.join(', '));
});

check('主进程推送的通道都在 preload 订阅白名单里', () => {
  const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(SRC, 'preload.js'), 'utf8');
  const subscribed = new Set([...preload.matchAll(/subscribe\('([^']+)'/g)].map((m) => m[1]));
  const windowsJs = fs.readFileSync(path.join(SRC, 'lib/windows.js'), 'utf8');
  const pushed = [...`${main}\n${windowsJs}`.matchAll(/webContents\.send\('([^']+)'/g)].map((m) => m[1]);
  const missing = [...new Set(pushed)].filter((c) => !subscribed.has(c));
  assert.deepStrictEqual(missing, [], 'preload 未订阅: ' + missing.join(', '));
});

check('已淘汰的旧实现不再存在', () => {
  const gone = ['lib/webagent.js', 'lib/history.js', 'dialog.html', 'floatball.html'];
  const still = gone.filter((f) => fs.existsSync(path.join(SRC, f)));
  assert.deepStrictEqual(still, [], '仍在: ' + still.join(', '));
});

check('悬浮球拖动：主进程跟随光标（不用 CSS 拖拽区、不逐帧 IPC、不调不存在的 API）', () => {
  const ball = fs.readFileSync(path.join(SRC, 'ball.html'), 'utf8');
  const preload = fs.readFileSync(path.join(SRC, 'preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  const win = fs.readFileSync(path.join(SRC, 'lib/windows.js'), 'utf8');
  // renderer 只在按下 / 松开时各发一次 IPC
  assert.ok(/dragStart\s*:/.test(preload), 'preload 应暴露 dragStart');
  assert.ok(/dragEnd\s*:/.test(preload), 'preload 应暴露 dragEnd');
  assert.ok(/ball-drag-start/.test(preload) && /ball-drag-start/.test(main), 'ball-drag-start 通道两端齐备');
  assert.ok(/ball-drag-end/.test(preload) && /ball-drag-end/.test(main), 'ball-drag-end 通道两端齐备');
  assert.ok(/api\.dragStart/.test(ball), 'ball.html 应在拖动阈值后调用 dragStart');
  assert.ok(/api\.dragEnd/.test(ball), 'ball.html 应在松手时调用 dragEnd');
  // 跟随由主进程轮询光标完成 —— 不逐帧 IPC，也就不会在队列里累积延迟
  assert.ok(/getCursorScreenPoint/.test(win), 'windows.js 应轮询光标位置来跟随鼠标');
  assert.ok(/setPosition/.test(win), 'windows.js 应用 setPosition 移动窗口');
  // 关键回归：绝不能调用 Electron 里根本不存在的 win.startWindowDrag()。
  // Electron 43 的 electron.d.ts 里没有它、运行时 typeof 是 undefined —— 这正是「拖动不了」的根因；
  // 而旧断言断言的恰好是「main.js 应调用 win.startWindowDrag()」，等于把这条死路锁死了。
  // 注释里允许作为反面教材提它，所以先去掉注释再查。
  const codeOnly = [ball, preload, main, win].map(stripComments).join('\n');
  assert.ok(!/startWindowDrag/.test(codeOnly), '不许调用不存在的 win.startWindowDrag()');
  // 回归：不能用 CSS 拖拽区，它在 Windows 上会吞掉鼠标事件导致球点不动。
  // 去注释后再查，否则说明性文字会被当成真实用法（曾误报）。
  const ballCode = stripComments(ball);
  assert.ok(!/-webkit-app-region\s*:\s*drag/i.test(ballCode), 'ball.html 不能用 -webkit-app-region: drag');
  // 回归：也不能在运行时把球设成拖拽区（曾有 contextmenu 里 ball.style.webkitAppRegion = 'drag'，
  // 导致右键一次之后球就再也点不动）。注意大小写：是 webkitAppRegion（大写 A），必须带 /i。
  assert.ok(!/appRegion\s*=\s*['"]drag['"]/i.test(ballCode), 'ball.html 不能在右键后把球设回拖拽区');
  // 回归：不能回到逐帧 IPC 移动窗口
  assert.ok(!/drag-ball/.test(preload) && !/drag-ball/.test(main), '不应再有 drag-ball 逐帧移动');
  // 结束拖动走页面显式发来的 dragEnd，不再依赖窗口 moved 的 180ms 防抖判断 ——
  // 那个防抖会在用户已按下、还没开始移动时把窗口吸到边上，制造出错误的抓取偏移。
  assert.ok(/function endFollowDrag/.test(win), 'windows.js 应有 endFollowDrag（松手即结束跟随）');
  assert.ok(!/moveEndTimer/.test(win), '不应再有 moved 防抖吸附（会在按下瞬间乱移窗口）');
  assert.ok(/FOLLOW_MAX_MS/.test(win), '应有「松手事件丢失」的时长兜底');
  // 抓取偏移必须由页面把**按下点**传进来，不能由主进程用「光标−窗口」反推
  assert.ok(/beginFollowDrag\(grab\)/.test(win), 'beginFollowDrag 应接收按下点作为抓取偏移');
  // 球几乎填满窗口，frameless 窗口在 Windows 上默认带 WS_THICKFRAME 调整边框，
  // 贴着球边缘按下会被系统当成"拉边框缩放"→ 窗口越拖越大 → 球元素居中布局跟着跑偏。
  assert.ok(/thickFrame:\s*false/.test(win), '球窗口必须 thickFrame:false，否则会被拖大');
  assert.ok(/api\.dragStart\(\{ x: pressX, y: pressY \}\)/.test(ball), 'ball.html 应把按下点随 dragStart 发出');
});

check('右键菜单走主进程原生菜单（48px 球窗口装不下 HTML 菜单）', () => {
  const ball = fs.readFileSync(path.join(SRC, 'ball.html'), 'utf8');
  const preload = fs.readFileSync(path.join(SRC, 'preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  // HTML 菜单宽 176px，球窗口只有 48px，必然被窗口边界裁掉 —— 只能交给原生 Menu.popup()
  assert.ok(/api\.contextMenu/.test(ball), 'ball.html 右键应调用 api.contextMenu');
  assert.ok(!/id="menu"/.test(ball), 'ball.html 不应再有窗口内 HTML 菜单');
  assert.ok(/contextMenu\s*:/.test(preload), 'preload 应暴露 contextMenu');
  assert.ok(/ball-context-menu/.test(preload) && /ball-context-menu/.test(main), 'ball-context-menu 通道两端齐备');
  assert.ok(/Menu\.buildFromTemplate\(appMenuItems\(\)\)\.popup/.test(main), 'main.js 应用原生菜单弹出');
  // 悬浮球右键与托盘右键必须共用同一份菜单项，避免两处漂移
  assert.ok(/menuTemplate:\s*appMenuItems\(\)/.test(main), '托盘应复用 appMenuItems()');
});

check('球窗口里不放任何文字 UI（48px 窗口显示不了）', () => {
  const ball = fs.readFileSync(path.join(SRC, 'ball.html'), 'utf8');
  const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  const win = fs.readFileSync(path.join(SRC, 'lib/windows.js'), 'utf8');
  const preload = fs.readFileSync(path.join(SRC, 'preload.js'), 'utf8');
  // 状态气泡宽 260px，在 48px 窗口里实测 DOM 矩形 x=-56,y=-98（整块在窗口外），
  // 从来没显示出来过 —— 已删除，别再加回来；操作反馈改为「弹网页窗口」+ 失败时的系统通知。
  assert.ok(!/class="toast"/.test(ball), 'ball.html 不应再有状态气泡');
  assert.ok(!/ball-status/.test(ball + main + win + preload), '不应再有 ball-status 通道');
  assert.ok(!/ballStatus/.test(main + win), '不应再有 ballStatus 调用');
  // 转圈忙碌态同理：截图时球本来就被 hide()，转给谁看
  assert.ok(!/classList\.toggle\('busy'/.test(ball), 'ball.html 不应再有忙碌态');
});

check('窗口加载的页面文件都真实存在', () => {
  const win = fs.readFileSync(path.join(SRC, 'lib/windows.js'), 'utf8');
  const pages = [...win.matchAll(/(?:BALL_PAGE|CAPTURE_PAGE)\s*=\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(pages.length >= 2, '应能解析出两个页面名');
  for (const p of pages) assert.ok(fs.existsSync(path.join(SRC, p)), `缺少页面 ${p}`);
});

check('没有残留的旧应用名', () => {
  const forbidden = [['DeepSeek', '解题助手'].join(' '), ['deepseek', 'capture', 'tool'].join('-')];
  const bad = [];
  for (const f of [...srcFiles, path.join(ROOT, 'README.md')]) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (forbidden.some((t) => line.includes(t))) bad.push(`${path.relative(ROOT, f)}:${i + 1}`);
    });
  }
  assert.deepStrictEqual(bad, [], '仍有旧名称: ' + bad.join(', '));
});

console.log('\n【4】图标资源');
check('图标文件齐全且为正方形 PNG', () => {
  const need = ['icon.png', 'icon-512.png', 'icon-64.png', 'icon-32.png', 'icon-16.png', 'tray.png', 'tray-dark.png'];
  for (const n of need) {
    const p = path.join(ROOT, 'build', n);
    assert.ok(fs.existsSync(p), `缺少 ${n}`);
    const b = fs.readFileSync(p);
    assert.strictEqual(b.readUInt32BE(16), b.readUInt32BE(20), `${n} 不是正方形`);
    assert.ok(b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), `${n} 不是合法 PNG`);
  }
});

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
process.exit(fail === 0 ? 0 : 1);
