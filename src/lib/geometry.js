'use strict';
/**
 * 纯函数几何工具（不依赖 electron，便于单元测试）
 */

const FLOATBALL_SIZE = 48;
const FLOATBALL_MARGIN = 20;

/**
 * 解析悬浮球初始位置。
 * 配置里的 floatballPos 可能为 null（首次运行）或来自损坏的配置，
 * 必须容错 —— 早期版本直接对 null 解构导致启动崩溃。
 *
 * 返回的坐标**一定落在工作区内**：存下的坐标可能来自另一套显示器布局
 * （拔掉副屏、改分辨率、拖动越界），不夹的话球会在屏幕外启动，
 * 用户既看不见也点不到，而且没有任何恢复入口。
 *
 * @param {*} pos  {x, y} | null | undefined | 任意值
 * @param {{x?:number,y?:number,width:number,height:number}} workArea 工作区（逻辑像素），x/y 缺省视为 0
 * @returns {{x:number, y:number}}
 */
function resolveFloatballPosition(pos, workArea) {
  const hasArea = !!(workArea && Number.isFinite(workArea.width) && Number.isFinite(workArea.height));
  const wa = hasArea ? workArea : { width: 1280, height: 720 };
  // 工作区原点：多屏时未必是 (0,0)（副屏在主屏左侧/上方时为负）
  const ax = Number.isFinite(wa.x) ? wa.x : 0;
  const ay = Number.isFinite(wa.y) ? wa.y : 0;
  // 默认位置 = 右下角（留 20px 边距）
  const defX = Math.max(ax, ax + wa.width - FLOATBALL_SIZE - FLOATBALL_MARGIN);
  const defY = Math.max(ay, ay + wa.height - FLOATBALL_SIZE - FLOATBALL_MARGIN);
  // 只有对象才当坐标读；字符串/数字等原始值一律视为「无记录」，
  // 否则 Number('') === 0 会得到一个假的 (0,0) 坐标
  const src = (pos && typeof pos === 'object') ? pos : {};
  const x = Number(src.x);
  const y = Number(src.y);
  const usable = Number.isFinite(x) && Number.isFinite(y)
    && x >= ax && x < ax + wa.width && y >= ay && y < ay + wa.height;
  if (usable) {
    // 有记录且落在这块工作区里 → 沿用，只夹到「整颗球可见」
    return {
      x: Math.min(Math.max(Math.round(x), ax), Math.max(ax, ax + wa.width - FLOATBALL_SIZE)),
      y: Math.min(Math.max(Math.round(y), ay), Math.max(ay, ay + wa.height - FLOATBALL_SIZE))
    };
  }
  // 没有记录、或坐标完全在屏幕外（拔副屏、改分辨率、拖动越界）→ 回到默认的**右下角**。
  // 这里刻意**不**把越界坐标夹到最近角落：那会把球丢到左上角，用户既意外又难找
  // （2026-10-01 实际发生：floatballPos={-111,-545} 被夹到 (0,0)）。
  return { x: defX, y: defY };
}

/**
 * 计算靠边吸附后的位置。
 * @param {{x:number,y:number}} pos 当前位置
 * @param {{width:number,height:number}} size 窗口尺寸
 * @param {{x:number,y:number,width:number,height:number}} wa 工作区
 * @param {number} snap 触发吸附的阈值
 */
function snapToEdges(pos, size, wa, snap = 28) {
  let x = pos.x, y = pos.y;
  if (x - wa.x < snap) x = wa.x;
  else if (wa.x + wa.width - (x + size.width) < snap) x = wa.x + wa.width - size.width;
  if (y - wa.y < snap) y = wa.y;
  else if (wa.y + wa.height - (y + size.height) < snap) y = wa.y + wa.height - size.height;
  // 必须取整：setPosition() 传小数会直接抛错
  // （实测 "Error processing argument at index 0, conversion failure from"），
  // 而 workArea 在小数缩放比下可能是小数（如 1228.8）。
  return {
    x: Math.round(Math.min(Math.max(x, wa.x), wa.x + wa.width - size.width)),
    y: Math.round(Math.min(Math.max(y, wa.y), wa.y + wa.height - size.height))
  };
}

/**
 * 抓取偏移：按下时鼠标相对窗口左上角的偏移。
 * 拖动全程复用这一个偏移，球才不会跳到鼠标正中心。
 */
function grabOffset(cursor, winPos) {
  return { x: cursor.x - winPos.x, y: cursor.y - winPos.y };
}

/**
 * 跟随鼠标时窗口应该在哪（纯函数）。
 * 必须 Math.round：cursor 可能是小数，而 setPosition() 只接受整数。
 */
function followPosition(cursor, offset) {
  return {
    x: Math.round(cursor.x - offset.x),
    y: Math.round(cursor.y - offset.y)
  };
}

module.exports = {
  resolveFloatballPosition,
  snapToEdges,
  grabOffset,
  followPosition,
  FLOATBALL_SIZE,
  FLOATBALL_MARGIN
};
