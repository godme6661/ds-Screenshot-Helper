'use strict';
/**
 * 核心流程测试：截图图片能否真的被送进网页的图片上传框
 *   node_modules\electron\dist\electron.exe tools\inject-test.js
 *
 * 这是本应用唯一的关键路径（截图 → 注入网页 → 跳转）。
 * 用一个模拟的聊天页替掉真实站点，验证：
 *   1. 注入后 file input 里确实出现了文件
 *   2. 附件预览出现在页面上（说明网页确实吃到了图片）
 *   3. sendScreenshot 返回 ok=true，且临时文件会被回收
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');

const webwin = require(path.join(__dirname, '..', 'src', 'lib', 'webwin.js'));

// ---- 生成一张真实的 PNG（32x32 纯色），走完整 dataURL 流程 ----
function makePngDataURL(size = 32) {
  const w = size, h = size;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const i = y * (w * 4 + 1) + 1 + x * 4;
      raw[i] = 90; raw[i + 1] = 160; raw[i + 2] = 230; raw[i + 3] = 255;
    }
  }
  const table = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; } return t; })();
  const crc = (b) => { let c = -1; for (let i = 0; i < b.length; i++) c = table[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

// ---- 模拟聊天页：有聊天输入框 + 文件上传框，change 时显示预览 ----
const MOCK = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>mock-chat</title></head><body>
<textarea id="chat-input" placeholder="给 DeepSeek 发送消息"></textarea>
<input type="file" id="file" multiple style="display:none">
<div id="preview"></div>
<script>
  document.getElementById('file').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const img = document.createElement('img');
    img.id = 'attached';
    img.src = URL.createObjectURL(f);
    document.getElementById('preview').appendChild(img);
    document.title = 'got:' + f.name + ':' + f.size;
  });
<\/script></body></html>`;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  webwin.setLogFile(path.join(os.tmpdir(), 'ds-inject-test-logs'));

  const win = webwin.ensureWindow();
  // 用模拟页替掉真实站点
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(MOCK));
  await new Promise((r) => setTimeout(r, 500));

  const before = await win.webContents.executeJavaScript(
    "document.getElementById('file').files.length", true);

  const tmpDir = os.tmpdir();
  const beforeShots = fs.readdirSync(tmpDir).filter((f) => /^ds-shot-.*\.png$/i.test(f));
  console.log(`注入前：file input 文件数=${before}，临时截图文件数=${beforeShots.length}`);

  const t0 = Date.now();
  const r = await webwin.sendScreenshot(makePngDataURL(), {
    onProgress: (m) => console.log('  进度:', m)
  });
  const ms = Date.now() - t0;

  const after = await win.webContents.executeJavaScript(`(() => {
    const f = document.getElementById('file');
    return {
      fileCount: f.files.length,
      firstName: f.files[0] ? f.files[0].name : null,
      fileSize: f.files[0] ? f.files[0].size : 0,
      preview: !!document.getElementById('attached'),
      title: document.title
    };
  })()`, true);

  console.log(`注入后：${JSON.stringify(after)}`);
  console.log(`sendScreenshot: ok=${r.ok}${r.reason ? ' reason=' + r.reason : ''}  用时=${ms}ms`);

  // 等临时文件回收（sendScreenshot 里 5s 后清理）
  await new Promise((r2) => setTimeout(r2, 6000));
  const afterShots = fs.readdirSync(tmpDir).filter((f) => /^ds-shot-.*\.png$/i.test(f));
  const leaked = afterShots.length - beforeShots.length;
  console.log(`临时文件：注入前 ${beforeShots.length} → 现在 ${afterShots.length}（本次泄漏 ${leaked}）`);

  const checks = [
    ['文件确实进了 file input', after.fileCount === 1],
    ['文件名是 ds-shot-*.png', /^ds-shot-.*\.png$/.test(after.firstName || '')],
    ['文件大小 > 0', after.fileSize > 0],
    ['页面收到 change 并渲染了预览', after.preview === true],
    ['sendScreenshot 返回 ok', r.ok === true],
    ['临时文件已回收（无泄漏）', leaked <= 0]
  ];

  console.log('\n=== 结果 ===');
  let failed = 0;
  for (const [name, pass] of checks) {
    if (!pass) failed++;
    console.log(`  ${pass ? '✅' : '❌'} ${name}`);
  }
  console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
  app.exit(failed ? 1 : 0);
}).catch((err) => {
  console.error('测试异常:', err);
  app.exit(1);
});
