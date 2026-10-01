'use strict';
/**
 * ds截图助手 图标生成器（零依赖：只用 Node 内置 zlib / fs / path）
 *
 *   node tools/make-icons.js [--out build]
 *
 * 产出：
 *   icon.png(256) / icon-512.png / icon-64.png / icon-32.png / icon-16.png
 *   tray.png        白色取景框（深色任务栏用）
 *   tray-dark.png   深灰取景框（浅色任务栏用）
 *   tray-16.png     16px 白色备用
 *
 * 设计：圆角方形对角渐变底 + 顶部柔光 + 白色取景框（四角括号 + 准星圆环 + 中心点）。
 * 全部几何按 256 基准归一化后按目标尺寸重绘，任意尺寸都清晰。
 * 确定性：无随机数、无时间戳，同样输入产生字节完全相同的输出。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ============ PNG 编码 ============
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ============ 画布（4x4 超采样抗锯齿） ============
const SS = 4;

class Canvas {
  constructor(size) {
    this.size = size;
    this.data = Buffer.alloc(size * size * 4, 0);
    this._mask = new Uint8Array(size * size); // 已绘制区域，用于叠加亮光
  }
  blend(px, py, r, g, b, a) {
    if (a <= 0 || px < 0 || py < 0 || px >= this.size || py >= this.size) return;
    if (a > 1) a = 1;
    const i = (py * this.size + px) * 4;
    const d = this.data;
    const da = d[i + 3] / 255;
    const oa = a + da * (1 - a);
    if (oa <= 0) { d[i + 3] = 0; return; }
    d[i] = Math.round((r * a + d[i] * da * (1 - a)) / oa);
    d[i + 1] = Math.round((g * a + d[i + 1] * da * (1 - a)) / oa);
    d[i + 2] = Math.round((b * a + d[i + 2] * da * (1 - a)) / oa);
    d[i + 3] = Math.round(oa * 255);
    if (oa > 0.5) this._mask[py * this.size + px] = 1;
  }
  /** 形状函数 + 超采样绘制；colorFn 返回 [r,g,b] */
  fillShape(test, colorFn, alpha = 1) {
    const step = 1 / SS;
    for (let py = 0; py < this.size; py++) {
      for (let px = 0; px < this.size; px++) {
        let hit = 0, r = 0, g = 0, b = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const x = px + (sx + 0.5) * step;
            const y = py + (sy + 0.5) * step;
            if (!test(x, y)) continue;
            const c = colorFn(x, y);
            hit++; r += c[0]; g += c[1]; b += c[2];
          }
        }
        if (!hit) continue;
        this.blend(px, py, r / hit, g / hit, b / hit, (hit / (SS * SS)) * alpha);
      }
    }
  }
  /** 对已绘制像素叠加白光（顶部柔光） */
  addGloss(shape, strength, zoneRatio) {
    const d = this.data;
    for (let py = 0; py < this.size; py++) {
      const k = strength * Math.max(0, 1 - py / (this.size * zoneRatio));
      if (k <= 0) continue;
      for (let px = 0; px < this.size; px++) {
        const i = (py * this.size + px) * 4;
        if (!this._mask[py * this.size + px]) continue;
        if (!shape(px + 0.5, py + 0.5)) continue;
        d[i] = Math.min(255, Math.round(d[i] + (255 - d[i]) * k));
        d[i + 1] = Math.min(255, Math.round(d[i + 1] + (255 - d[i + 1]) * k));
        d[i + 2] = Math.min(255, Math.round(d[i + 2] + (255 - d[i + 2]) * k));
      }
    }
  }
  toPNG() { return encodePNG(this.size, this.size, this.data); }
}

// ============ 几何 / 颜色 ============
function roundRectTest(x0, y0, w, h, radius) {
  const x1 = x0 + w, y1 = y0 + h;
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  return (x, y) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    if (r <= 0) return true;
    const cx = Math.min(Math.max(x, x0 + r), x1 - r);
    const cy = Math.min(Math.max(y, y0 + r), y1 - r);
    const dx = x - cx, dy = y - cy;
    return dx * dx + dy * dy <= r * r;
  };
}
function circleTest(cx, cy, r) {
  return (x, y) => {
    const dx = x - cx, dy = y - cy;
    return dx * dx + dy * dy <= r * r;
  };
}
function ringTest(cx, cy, outer, thickness) {
  const inner = Math.max(0, outer - thickness);
  return (x, y) => {
    const dx = x - cx, dy = y - cy;
    const d2 = dx * dx + dy * dy;
    return d2 <= outer * outer && d2 >= inner * inner;
  };
}
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [
  Math.round(lerp(c1[0], c2[0], t)),
  Math.round(lerp(c1[1], c2[1], t)),
  Math.round(lerp(c1[2], c2[2], t))
];

const BLUE = [74, 144, 217];
const PURPLE = [108, 92, 231];
const WHITE = [255, 255, 255];
const DARK = [30, 34, 46];

function drawIcon(size, { background, fg }) {
  const c = new Canvas(size);
  const S = size / 256;

  if (background) {
    const pad = 4 * S;
    const shape = roundRectTest(pad, pad, size - pad * 2, size - pad * 2, 54 * S);
    const inner = size - pad * 2;
    c.fillShape(shape, (x, y) => {
      const t = Math.min(1, Math.max(0, ((x - pad) / inner) * 0.58 + ((y - pad) / inner) * 0.42));
      const col = mix(BLUE, PURPLE, t);
      const v = 1 + 0.05 * (1 - (y - pad) / inner) - 0.03 * ((y - pad) / inner);
      return [Math.min(255, col[0] * v), Math.min(255, col[1] * v), Math.min(255, col[2] * v)];
    });
    c.addGloss(shape, 0.16, 0.5);
  }

  const color = fg || WHITE;
  const col = () => color;

  // ---- 取景框：四角 L 形括号 ----
  const thick = Math.max(1.5, 15 * S);
  const len = 56 * S;
  const inset = 56 * S;
  const x0 = inset, y0 = inset;
  const x1 = size - inset, y1 = size - inset;
  const hBar = (x, y, w, h) => roundRectTest(x, y, w, h, Math.min(h, w) / 2);
  const vBar = (x, y, w, h) => roundRectTest(x, y, w, h, Math.min(h, w) / 2);

  c.fillShape(hBar(x0, y0, len, thick), col);
  c.fillShape(vBar(x0, y0, thick, len), col);
  c.fillShape(hBar(x1 - len, y0, len, thick), col);
  c.fillShape(vBar(x1 - thick, y0, thick, len), col);
  c.fillShape(hBar(x0, y1 - thick, len, thick), col);
  c.fillShape(vBar(x0, y1 - len, thick, len), col);
  c.fillShape(hBar(x1 - len, y1 - thick, len, thick), col);
  c.fillShape(vBar(x1 - thick, y1 - len, thick, len), col);

  // ---- 中心准星：圆环 + 实心点 ----
  const cx = size / 2, cy = size / 2;
  c.fillShape(ringTest(cx, cy, 37 * S, 7 * S), col);
  c.fillShape(circleTest(cx, cy, 15 * S), col);

  return c;
}

// ============ 自检解码（仅处理本编码器产物） ============
function decodePNG(buf) {
  let pos = 8;
  let width = 0, height = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.slice(pos + 4, pos + 8).toString('ascii');
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    if (f !== 0) throw new Error('自检解码仅支持 filter=0，遇到 ' + f);
    raw.copy(out, y * stride, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
  }
  return { width, height, data: out };
}

// ============ 主流程 ============
function main() {
  const argv = process.argv.slice(2);
  let outDir = 'build';
  const i = argv.indexOf('--out');
  if (i >= 0 && argv[i + 1]) outDir = argv[i + 1];
  const abs = path.isAbsolute(outDir) ? outDir : path.join(process.cwd(), outDir);
  fs.mkdirSync(abs, { recursive: true });

  const written = [];
  const write = (name, buf) => {
    fs.writeFileSync(path.join(abs, name), buf);
    written.push({ name, size: buf.length });
  };

  for (const s of [16, 32, 64, 256, 512]) {
    write(s === 256 ? 'icon.png' : `icon-${s}.png`, drawIcon(s, { background: true, fg: null }).toPNG());
  }
  write('tray.png', drawIcon(32, { background: false, fg: WHITE }).toPNG());
  write('tray-16.png', drawIcon(16, { background: false, fg: WHITE }).toPNG());
  write('tray-dark.png', drawIcon(32, { background: false, fg: DARK }).toPNG());

  console.log(`图标已生成到 ${abs}`);
  written.forEach((w) => console.log(`  ${w.name.padEnd(15)} ${String(w.size).padStart(7)} B`));

  let ok = true;
  for (const w of written) {
    const buf = fs.readFileSync(path.join(abs, w.name));
    const sigOk = buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
    const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
    if (!sigOk || width !== height) { ok = false; console.log(`  ✗ ${w.name} 校验失败`); }
    else console.log(`  ✓ ${w.name} ${width}x${height}`);
  }

  const img = decodePNG(fs.readFileSync(path.join(abs, 'icon.png')));
  const { width, height, data } = img;
  const total = width * height;
  let opaque = 0, whiteish = 0, cornerOpaque = 0;
  for (let p = 0; p < total; p++) {
    const a = data.readUInt8(p * 4 + 3);
    if (a <= 200) continue;
    opaque++;
    const r = data.readUInt8(p * 4), g = data.readUInt8(p * 4 + 1), b = data.readUInt8(p * 4 + 2);
    if (r > 195 && g > 195 && b > 195) whiteish++;
    const px = p % width, py = (p / width) | 0;
    if (px < 2 || py < 2 || px >= width - 2 || py >= height - 2) cornerOpaque++;
  }
  const ratio = opaque / total, whiteRatio = whiteish / total;
  console.log(`自检 icon.png：不透明 ${(ratio * 100).toFixed(1)}%，白色前景 ${(whiteRatio * 100).toFixed(1)}%，边缘残留 ${cornerOpaque}px`);
  if (ratio < 0.55 || ratio > 0.98) { ok = false; console.log('  ✗ 底板占比异常'); }
  if (whiteRatio < 0.04) { ok = false; console.log('  ✗ 白色前景过少，取景框可能没画出来'); }
  if (cornerOpaque > 0) { ok = false; console.log('  ✗ 边缘存在不透明像素，圆角没生效'); }

  const tray = decodePNG(fs.readFileSync(path.join(abs, 'tray.png')));
  let trayOpaque = 0;
  for (let p = 0; p < tray.width * tray.height; p++) if (tray.data.readUInt8(p * 4 + 3) > 200) trayOpaque++;
  const trayRatio = trayOpaque / (tray.width * tray.height);
  console.log(`自检 tray.png：不透明 ${(trayRatio * 100).toFixed(1)}%（应 5%~40%）`);
  if (trayRatio < 0.05 || trayRatio > 0.4) { ok = false; console.log('  ✗ 托盘图标占比异常'); }

  console.log(ok ? '\n全部自检通过' : '\n自检未通过');
  process.exit(ok ? 0 : 1);
}

main();
