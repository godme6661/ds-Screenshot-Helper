'use strict';
/**
 * 截图数据准备：合并多屏为一张「物理像素」画布所需的原始数据。
 * 混合 DPI（每屏不同 scaleFactor）下也能精确定位。
 */
const { desktopCapturer, screen } = require('electron');

const MAX_THUMB = 8192; // 单边上限，防止极端分辨率下内存暴涨

async function captureScreensData() {
  const displays = screen.getAllDisplays();
  if (!displays.length) throw new Error('未检测到显示器');

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  displays.forEach((d) => {
    minX = Math.min(minX, d.bounds.x);
    minY = Math.min(minY, d.bounds.y);
    maxX = Math.max(maxX, d.bounds.x + d.bounds.width);
    maxY = Math.max(maxY, d.bounds.y + d.bounds.height);
  });
  const totalBounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };

  // 缩略图请求尺寸取所有屏幕物理像素的最大值（而非第一块屏幕），保证任意屏幕都不被放大
  const thumbW = Math.min(MAX_THUMB, Math.max(1, Math.round(Math.max(...displays.map((d) => d.bounds.width * d.scaleFactor)))));
  const thumbH = Math.min(MAX_THUMB, Math.max(1, Math.round(Math.max(...displays.map((d) => d.bounds.height * d.scaleFactor)))));

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: thumbW, height: thumbH }
  });

  if (!sources || sources.length === 0) throw new Error('无法获取屏幕截图（可能被系统权限或安全软件拦截）');
  if (sources.length < displays.length) {
    console.warn(`屏幕数量不匹配：显示器 ${displays.length} 个，截图源 ${sources.length} 个`);
  }

  // desktopCapturer 返回顺序不保证与 getAllDisplays 一致：优先按 display_id 匹配
  const screens = displays
    .map((d, i) => {
      let src = null;
      if (d.id != null && String(d.id) !== '') {
        src = sources.find((s) => String(s.display_id) === String(d.id)) || null;
      }
      if (!src) src = sources[i] || null;
      if (!src) return null;
      return {
        imageDataURL: src.thumbnail.toDataURL(),
        x: d.bounds.x - totalBounds.x,
        y: d.bounds.y - totalBounds.y,
        width: d.bounds.width,
        height: d.bounds.height,
        scaleFactor: d.scaleFactor
      };
    })
    .filter(Boolean);

  if (!screens.length) throw new Error('无法获取屏幕截图');
  return { totalBounds, screens };
}

module.exports = { captureScreensData };
