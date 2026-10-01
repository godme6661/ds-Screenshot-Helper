'use strict';
/**
 * 网页结构探测：把 chat.deepseek.com 上「回答到底在哪个节点里」查清楚。
 *   node_modules\electron\dist\electron.exe tools\probe-dom.js
 *   node_modules\electron\dist\electron.exe tools\probe-dom.js --full     # 附完整 DOM 树
 *   node_modules\electron\dist\electron.exe tools\probe-dom.js --send "你好"  # 自动发一条消息再探测
 *
 * 输出同时写入项目根目录的 probe-result.txt，可直接把这个文件发给我。
 * 用途：DeepSeek 改版导致抓不到回答时，用它定位真实的选择器，然后改
 * src/lib/webagent.js 顶部的 SELECTORS 即可。
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'probe-result.txt');
const argv = process.argv.slice(2);
const FULL = argv.includes('--full');
const sendIdx = argv.indexOf('--send');
const SEND_TEXT = sendIdx >= 0 ? (argv[sendIdx + 1] || '你好') : null;

const lines = [];
function out(s) {
  lines.push(s);
  process.stdout.write(s + '\n');
}

const PROBE_JS = `(() => {
  const info = (sel) => {
    try {
      const n = document.querySelectorAll(sel);
      if (!n.length) return null;
      return { sel, count: n.length, sample: (n[n.length - 1].innerText || '').slice(0, 120) };
    } catch (e) { return null; }
  };
  const res = { url: location.href, title: document.title, probes: [] };
  const candidates = [
    '.ds-markdown', '.ds-markdown--block', '.ds-markdown-paragraph',
    '.markdown-body', '[class*="markdown"]',
    '[class*="answer"]', '[class*="response"]', '[class*="reply"]', '[class*="message"]',
    '[data-message-author-role]', '[data-testid*="message"]', '[data-testid*="answer"]',
    'div[class*="_"]'
  ];
  for (const c of candidates) {
    const r = info(c);
    if (r) res.probes.push(r);
  }
  // 输入区与发送按钮
  res.inputs = ['textarea#chat-input', 'textarea[placeholder]', 'div[contenteditable="true"]']
    .map((s) => info(s)).filter(Boolean);
  res.sends = ['div[aria-label="发送"]', 'div[role="button"][aria-label="发送"]', 'button[type="submit"]',
    'button[aria-label*="发送"]', '[role="button"][aria-label*="Send" i]', '[aria-label*="停止"]', '[data-testid*="stop" i]']
    .map((s) => info(s)).filter(Boolean);
  // 把所有「像发送按钮」的元素结构列出来——定位发送按钮用（点不动/找不到时看这里）
  res.sendCandidates = [];
  const seen = new Set();
  for (const b of document.querySelectorAll('button, [role="button"], [class*="send"], [class*="submit"], [class*="arrow"]')) {
    if (seen.has(b)) continue;
    const aria = b.getAttribute('aria-label') || '';
    const txt = (b.textContent || '').trim();
    const cls = (typeof b.className === 'string') ? b.className : '';
    const id = b.id || '';
    if (!/发送|send|submit/i.test(aria + ' ' + txt + ' ' + cls + ' ' + id)) continue;
    seen.add(b);
    res.sendCandidates.push({
      tag: b.tagName, id, class: cls.slice(0, 80), aria, text: txt.slice(0, 30),
      disabled: !!(b.disabled || b.getAttribute('aria-disabled') === 'true' || /disabled/i.test(cls)),
      visible: !!(b.offsetParent || (b.getClientRects && b.getClientRects().length)),
      html: b.outerHTML.slice(0, 220)
    });
    if (res.sendCandidates.length >= 12) break;
  }
  // 输入框的标签/类型（判断是 textarea 还是 contenteditable）
  res.inputShapes = [];
  for (const s of ['textarea#chat-input', 'textarea', 'div[contenteditable="true"]']) {
    try {
      for (const el of document.querySelectorAll(s)) {
        res.inputShapes.push({ sel: s, tag: el.tagName, placeholder: el.getAttribute('placeholder') || '', cls: (typeof el.className === 'string' ? el.className : '').slice(0, 60) });
        break;
      }
    } catch (e) {}
  }
  res.files = ['input[type="file"]'].map((s) => info(s)).filter(Boolean);
  res.bodyLen = (document.body && document.body.innerText || '').length;
  res.tail = (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').slice(-600);
  return res;
})()`;

const FULL_JS = `(() => {
  const walk = (el, depth, max) => {
    if (depth > max) return '';
    let s = '';
    const kids = el.children ? Array.from(el.children).slice(0, 12) : [];
    for (const k of kids) {
      const cls = (k.className && typeof k.className === 'string') ? k.className.trim().slice(0, 90) : '';
      const own = Array.from(k.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').slice(0, 60);
      s += '  '.repeat(depth) + '<' + k.tagName.toLowerCase() + (cls ? ' class="' + cls + '"' : '') + '>' +
           (own ? ' «' + own + '»' : '') + '\\n';
      s += walk(k, depth + 1, max);
    }
    return s;
  };
  return walk(document.body, 0, 7);
})()`;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  out('=== ds截图助手 · 网页结构探测 ===');
  out('时间: ' + new Date().toLocaleString());

  // 直接复用应用自己的网页自动化模块（同一登录分区，已登录状态直接可用）
  const webagent = require(path.join(ROOT, 'src', 'lib', 'webagent.js'));
  const win = webagent.ensureWindow();
  out('正在打开 chat.deepseek.com ...');
  await win.loadURL(webagent.WEB_URL);
  await new Promise((r) => setTimeout(r, 2500));

  const state = await webagent.getLoginState();
  out('登录状态: ' + state);
  out('当前选择器配置: ' + JSON.stringify(webagent.SELECTORS, null, 1));

  if (state !== 'logged_in') {
    out('');
    out('!! 未登录：请在弹出的窗口里登录 DeepSeek，然后重新运行本工具。');
    out('   （本工具会显示登录窗口 60 秒）');
    win.show();
    await new Promise((r) => setTimeout(r, 60000));
  } else {
    win.hide();
  }

  if (SEND_TEXT) {
    out('');
    out(`自动发送测试消息: "${SEND_TEXT}"`);
    const setOk = await win.webContents.executeJavaScript(`
      (() => {
        const ta = document.querySelector('textarea#chat-input') || document.querySelector('textarea');
        if (!ta) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, ${JSON.stringify(SEND_TEXT)});
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()
    `, true);
    out('  写入输入框: ' + setOk);
    if (setOk) {
      await win.webContents.executeJavaScript(`
        (() => {
          const b = document.querySelector('div[aria-label="发送"]') || document.querySelector('button[type="submit"]');
          if (b) { b.click(); return true; }
          const ta = document.querySelector('textarea');
          if (ta) { ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true })); return true; }
          return false;
        })()
      `, true);
      out('  已发送，等待 15 秒让回答渲染...');
      await new Promise((r) => setTimeout(r, 15000));
    }
  }

  const r = await win.webContents.executeJavaScript(PROBE_JS, true);
  out('');
  out('--- 回答相关选择器命中情况 ---');
  if (!r || !r.probes.length) {
    out('（所有候选选择器都没命中！说明回答容器换了结构，需要看下面的 DOM 树）');
  } else {
    for (const p of r.probes) {
      out(`  ${p.count} 个  ${p.sel}`);
      out(`        样本: ${JSON.stringify(p.sample)}`);
    }
  }
  out('');
  out('--- 输入区 ---');
  for (const p of (r && r.inputs) || []) out(`  ${p.count} 个  ${p.sel}`);
  out('--- 发送/停止按钮 ---');
  for (const p of (r && r.sends) || []) out(`  ${p.count} 个  ${p.sel}  样本: ${JSON.stringify(p.sample)}`);
  out('');
  out('--- 所有「像发送按钮」的元素（发送点不动时重点看这段） ---');
  const sc = (r && r.sendCandidates) || [];
  if (!sc.length) {
    out('  （没找到任何候选！说明发送按钮的结构既没有 send/submit 关键字也没有「发送」文案）');
  } else {
    sc.forEach((x, i) => {
      out(`  [${i}] <${x.tag}> id="${x.id}" class="${x.class}" aria="${x.aria}" text="${x.text}" disabled=${x.disabled} visible=${x.visible}`);
      out(`       ${x.html}`);
    });
  }
  out('');
  out('--- 输入框形态 ---');
  for (const x of (r && r.inputShapes) || []) {
    out(`  ${x.sel} → <${x.tag}> placeholder="${x.placeholder}" class="${x.cls}"`);
  }
  out('--- 文件上传框 ---');
  for (const p of (r && r.files) || []) out(`  ${p.count} 个  ${p.sel}`);
  out('');
  out(`页面可见文本长度: ${(r && r.bodyLen) || 0}`);
  out(`页面尾部文本: ${(r && r.tail) || ''}`);

  if (FULL) {
    out('');
    out('--- DOM 树（body 起 7 层） ---');
    const tree = await win.webContents.executeJavaScript(FULL_JS, true);
    out(tree || '(空)');
  } else {
    out('');
    out('（如需完整 DOM 树，加 --full 参数重新运行）');
  }

  fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
  out('');
  out('结果已写入: ' + OUT);
  out('把这个文件内容发给我即可定位。');
  app.exit(0);
}).catch((err) => {
  out('探测失败: ' + (err && err.stack ? err.stack : err));
  try { fs.writeFileSync(OUT, lines.join('\n'), 'utf8'); } catch (_) { /* 忽略 */ }
  app.exit(1);
});
