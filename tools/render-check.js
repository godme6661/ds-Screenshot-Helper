'use strict';
/**
 * 界面渲染自检：离屏加载 ball.html / capture.html 并截图到 preview/shots/
 *   node_modules/electron/dist/electron.exe tools/render-check.js --list
 *   node_modules/electron/dist/electron.exe tools/render-check.js --scene ball
 *
 * 截图前会统一禁用过渡与动画 —— 离屏软件合成下，带 transition/关键帧的图层
 * 会「计算样式正确但画不出来」，截到的是起跑帧，容易误判成功能坏掉。
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '..', 'preview', 'shots');
const SRC = path.join(__dirname, '..', 'src');

const SCENES = {
  ball: { file: 'ball.html', name: 'ball.png', w: 170, h: 100, bg: '#1b2440' },
  capture: { file: 'capture.html', name: 'capture.png', w: 720, h: 420, bg: '#000000' },
  capturepicked: {
    file: 'capture.html', name: 'capture-picked.png', w: 720, h: 420, bg: '#000000',
    script: "const tb=document.getElementById('toolbar');tb.classList.add('show');tb.style.opacity='1';document.getElementById('btnConfirm').disabled=false;document.getElementById('sizeInfo').textContent='420 × 180'"
  }
};

const argv = process.argv.slice(2);
if (argv.includes('--list')) {
  console.log('可用场景：' + Object.keys(SCENES).join(', '));
  app.exit(0);
}
const idx = argv.indexOf('--scene');
const key = idx >= 0 && argv[idx + 1] ? argv[idx + 1] : 'ball';
const scene = SCENES[key];
if (!scene) {
  console.error(`未知场景 "${key}"，可用：${Object.keys(SCENES).join(', ')}`);
  app.exit(2);
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({
    width: scene.w,
    height: scene.h,
    show: false,
    backgroundColor: scene.bg || '#1b2440',
    webPreferences: { preload: path.join(SRC, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  await win.loadFile(path.join(SRC, scene.file));
  await new Promise((r) => setTimeout(r, 700));
  await win.webContents.executeJavaScript(
    "const s=document.createElement('style');s.textContent='*,*::before,*::after{transition:none!important;animation:none!important}';document.head.appendChild(s);",
    true
  );
  await new Promise((r) => setTimeout(r, 200));
  if (scene.script) {
    await win.webContents.executeJavaScript(scene.script, true);
    await new Promise((r) => setTimeout(r, 500));
  }
  const img = await win.webContents.capturePage();
  const buf = img.toPNG();
  fs.writeFileSync(path.join(OUT, scene.name), buf);
  const size = img.getSize();
  console.log(`[shot] ${scene.name}  ${size.width}x${size.height}  ${buf.length} B`);
  app.exit(0);
}).catch((err) => {
  console.error('渲染自检失败:', err.message);
  app.exit(1);
});
