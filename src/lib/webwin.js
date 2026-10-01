'use strict';
/**
 * DeepSeek 网页窗口
 * ---------------------------------------------------------------
 * 这个模块只做三件事：
 *   1. 维护一个**用户可见、可交互**的 chat.deepseek.com 窗口（登录态持久化）
 *   2. 把截图注入网页的图片上传框
 *   3. 把窗口弹到前台并聚焦
 *
 * 刻意不做的事：不代填问题、不点发送、不抓回答。
 * 发送和对话都在网页里由用户自己完成——这样最稳，也没有超时/误判问题。
 */
const { BrowserWindow, session, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const WEB_URL = 'https://chat.deepseek.com/';
const PARTITION = 'persist:deepseek-web';

let webWin = null;
let tempFiles = [];
let logFile = null;

// ============ 网页选择器（改版时只需改这里） ============
const SELECTORS = {
  // 聊天输入框：用于判断「已登录且页面就绪」
  input: [
    'textarea#chat-input',
    'textarea[placeholder*="消息"]',
    'textarea[placeholder*="输入"]',
    'div[contenteditable="true"][role="textbox"]'
  ],
  // 登录页特征（出现即视为未登录）
  loginForm: [
    'input[type="password"]',
    'input[type="tel"]',
    'input[placeholder*="手机号"]',
    'input[placeholder*="验证码"]',
    'input[maxlength="6"]',
    'input[autocomplete="one-time-code"]'
  ],
  // 文件上传 input（CDP 注入图片用）
  fileInput: 'input[type="file"]',
  // 附件已挂载的迹象
  attachmentHint: ['img[src^="blob:"]', 'img[src^="data:image"]', '[class*="attach"]', '[class*="upload"]']
};

// ============ 日志 ============
function setLogFile(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'webagent.log');
    fs.writeFileSync(logFile, `# ds截图助手 日志 ${new Date().toLocaleString()}\n`, 'utf8');
  } catch (err) {
    console.error('初始化日志文件失败:', err.message);
  }
}
function getLogFile() {
  return logFile;
}
function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(`[web] ${line}`);
  if (logFile) {
    try { fs.appendFileSync(logFile, line + '\n', 'utf8'); } catch (_) { /* 忽略 */ }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, { timeout = 10000, interval = 250 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start >= timeout) return null;
    await sleep(interval);
  }
}

function getSession() {
  return session.fromPartition(PARTITION);
}

// ============ 窗口 ============
function createWindow({ icon } = {}) {
  if (webWin && !webWin.isDestroyed()) return webWin;
  getSession(); // 确保分区存在（登录态落盘）
  webWin = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: 'DeepSeek 网页版 · ds截图助手',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    icon,
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // 后台时也让页面正常渲染（注入图片依赖它）
      backgroundThrottling: false
    }
  });
  webWin.loadURL(WEB_URL);
  webWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !url.includes('chat.deepseek.com')) shell.openExternal(url);
    return { action: 'deny' };
  });
  webWin.on('closed', () => { webWin = null; });
  return webWin;
}

function getWindow() {
  return (webWin && !webWin.isDestroyed()) ? webWin : null;
}

function ensureWindow(opts) {
  return getWindow() || createWindow(opts);
}

function waitForLoad(timeout = 20000) {
  return new Promise((resolve) => {
    const win = getWindow();
    if (!win) return resolve(false);
    if (!win.webContents.isLoading()) return resolve(true);
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    win.webContents.once('did-finish-load', () => finish(true));
    win.webContents.once('did-fail-load', () => finish(false));
    setTimeout(() => finish(!win.webContents.isLoading()), timeout);
  });
}

async function exec(js) {
  const win = getWindow();
  if (!win) return null;
  try {
    return await win.webContents.executeJavaScript(js, true);
  } catch (err) {
    log(`执行网页脚本失败: ${err.message}`);
    return null;
  }
}

/** 把网页窗口弹到前台并聚焦（截图后「跳转过去」就是这一步） */
function showWindow({ focus = true } = {}) {
  const win = ensureWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  if (focus) {
    win.focus();
    try { win.moveTop(); } catch (_) { /* 某些平台不支持 */ }
  }
  return win;
}

// ============ 登录状态 ============
/** 'logged_in' | 'not_logged_in' | 'blocked' | 'unloaded' */
async function getLoginState() {
  const win = getWindow();
  if (!win || win.webContents.isLoading()) return 'unloaded';
  const r = await exec(`
    (() => {
      const hit = (sels) => {
        for (const s of sels) { try { if (document.querySelector(s)) return s; } catch (e) {} }
        return null;
      };
      const body = (document.body && document.body.innerText) || '';
      return {
        chatInput: hit(${JSON.stringify(SELECTORS.input)}),
        loginForm: hit(${JSON.stringify(SELECTORS.loginForm)}),
        pathname: location.pathname,
        loginPage: /发送验证码|获取验证码|密码登录|微信扫码登录|注册登录即代表|用户协议|隐私政策/.test(body),
        blocked: /使用环境异常|环境存在.*风险|官方产品/.test(body)
      };
    })()
  `);
  if (!r) return 'unloaded';
  if (r.blocked && !r.chatInput) return 'blocked';
  if (r.loginForm || r.loginPage) return 'not_logged_in';
  if (r.chatInput) return 'logged_in';
  if (/sign_in|signin|login|auth/i.test(r.pathname)) return 'not_logged_in';
  return 'not_logged_in';
}

async function isChatReady() {
  return !!(await exec(`
    (() => {
      const sels = ${JSON.stringify(SELECTORS.input)};
      return sels.some((s) => { try { return !!document.querySelector(s); } catch (e) { return false; } });
    })()
  `));
}

/** 等待进入可聊天的页面（已登录）。返回 true/false */
async function waitUntilReady(timeout = 25000) {
  const ok = await waitFor(async () => (await getLoginState()) === 'logged_in', { timeout, interval: 400 });
  return !!ok;
}

// ============ 图片注入 ============
function writeTempImage(imageBase64) {
  const b64 = String(imageBase64).split(',')[1];
  if (!b64) throw new Error('图片数据无效');
  const p = path.join(os.tmpdir(), `ds-shot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`);
  fs.writeFileSync(p, Buffer.from(b64, 'base64'));
  tempFiles.push(p);
  return p;
}

function cleanupTempFiles() {
  const files = tempFiles;
  tempFiles = [];
  let n = 0;
  files.forEach((f) => { try { fs.unlinkSync(f); n++; } catch (_) {} });
  return n;
}

function cleanupStaleTempFiles(maxAgeMs = 24 * 3600 * 1000) {
  let n = 0;
  try {
    const now = Date.now();
    fs.readdirSync(os.tmpdir())
      .filter((f) => /^ds-shot-.*\.png$/i.test(f) || /^deepseek-question-.*\.png$/i.test(f))
      .forEach((f) => {
        const p = path.join(os.tmpdir(), f);
        try { if (now - fs.statSync(p).mtimeMs > maxAgeMs) { fs.unlinkSync(p); n++; } } catch (_) {}
      });
  } catch (err) {
    console.error('清理历史临时文件失败:', err.message);
  }
  return n;
}

/** 通过 CDP 把文件写进网页的 file input（等价于用户手动选文件） */
async function injectImageFile(filePath) {
  const win = getWindow();
  if (!win) return false;
  const dbg = win.webContents.debugger;
  try { dbg.attach('1.3'); } catch (_) { /* 已附加 */ }
  try {
    await dbg.sendCommand('DOM.enable');
    const { root } = await dbg.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
    const { nodeId } = await dbg.sendCommand('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: SELECTORS.fileInput
    });
    if (!nodeId) return false;
    await dbg.sendCommand('DOM.setFileInputFiles', { nodeId, files: [filePath] });
    return true;
  } catch (err) {
    log(`注入图片失败: ${err.message}`);
    return false;
  } finally {
    try { dbg.detach(); } catch (_) {}
  }
}

/** 轻量确认附件是否已挂上（仅用于日志，不作为成败依据） */
async function isAttachmentMounted() {
  return !!(await exec(`
    (() => {
      for (const s of ${JSON.stringify(SELECTORS.attachmentHint)}) {
        try { if (document.querySelector(s)) return true; } catch (e) {}
      }
      return false;
    })()
  `));
}

/**
 * 截图 → 网页：把图片塞进网页输入框，然后把窗口弹到前台
 * @param {string} imageBase64 dataURL
 * @param {{icon?:any, onProgress?:(msg:string)=>void}} opts
 * @returns {{ok:boolean, reason?:string}}
 */
async function sendScreenshot(imageBase64, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  if (!imageBase64 || !String(imageBase64).startsWith('data:image')) {
    return { ok: false, reason: '图片数据无效' };
  }

  const win = ensureWindow({ icon: opts.icon });
  onProgress('正在打开 DeepSeek 网页...');
  const loaded = await waitForLoad();
  if (!loaded) return { ok: false, reason: '网页加载失败，请检查网络' };

  // 未登录：把窗口亮出来让用户登录，先不注入
  let state = await getLoginState();
  if (state !== 'logged_in') {
    showWindow();
    const ready = await waitUntilReady(30000);
    if (!ready) {
      state = await getLoginState();
      return {
        ok: false,
        reason: state === 'blocked'
          ? '网页版提示「使用环境异常」，请在这个窗口里重新登录后再试'
          : '还没登录 DeepSeek，请在弹出的网页窗口里登录后再按一次截图'
      };
    }
  }

  // 先让用户看到网页窗口，再注入（注入过程用户能直接看到图片出现在输入框里）
  showWindow();
  await sleep(150);
  onProgress('正在把图片送入网页...');

  let tmp;
  try {
    tmp = writeTempImage(imageBase64);
  } catch (err) {
    return { ok: false, reason: `准备图片失败：${err.message}` };
  }

  let injected = false;
  for (let attempt = 1; attempt <= 3 && !injected; attempt++) {
    injected = await injectImageFile(tmp);
    if (!injected) {
      log(`第 ${attempt} 次注入失败，重试...`);
      await sleep(600);
    }
  }
  if (!injected) {
    return { ok: false, reason: '没能把图片送进网页（网页结构可能已变化，也可以手动把图片粘贴进去）' };
  }

  const mounted = await waitFor(() => isAttachmentMounted(), { timeout: 2000, interval: 200 });
  log(`图片已注入（附件${mounted ? '已确认' : '未捕捉到，不影响'}）`);
  onProgress('图片已送入网页，直接输入问题即可');

  // 网页已经拿到文件了，临时文件可以删（延后一点，避免读取未完成）
  setTimeout(() => cleanupTempFiles(), 5000);

  // 聚焦到输入框，用户可以直接打字
  await exec(`
    (() => {
      for (const s of ${JSON.stringify(SELECTORS.input)}) {
        const el = document.querySelector(s);
        if (el) { try { el.focus(); } catch (e) {} return true; }
      }
      return false;
    })()
  `);

  return { ok: true };
}

/** 显示一条系统通知（可选，用户关掉也不影响流程） */
function notify(title, body) {
  try {
    if (!Notification.isSupported()) return;
    new Notification({ title, body, silent: false }).show();
  } catch (_) { /* 忽略 */ }
}

module.exports = {
  WEB_URL,
  SELECTORS,
  createWindow,
  getWindow,
  ensureWindow,
  showWindow,
  getLoginState,
  isChatReady,
  waitUntilReady,
  waitForLoad,
  sendScreenshot,
  notify,
  cleanupTempFiles,
  cleanupStaleTempFiles,
  setLogFile,
  getLogFile
};
