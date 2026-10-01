'use strict';
/**
 * preload：悬浮球 / 截图遮罩 与主进程之间的白名单桥梁。
 * 精简版：没有提问、历史、设置面板相关接口。
 * 注意：悬浮球拖动**经过这里**——dragStart / dragEnd 只负责「何时开始 / 结束」，
 * 真正的窗口移动由主进程轮询光标完成（既不逐帧 IPC，也不依赖并不存在的 startWindowDrag）。
 * 不要改用 CSS 拖拽区：它在 Windows 上会吞掉页面鼠标事件，单击/右键都收不到，球会点不动。
 */
const { contextBridge, ipcRenderer } = require('electron');

/** 订阅主进程消息，返回取消订阅函数 */
function subscribe(channel, callback) {
  const handler = (_event, data) => callback(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('electronAPI', {
  appName: 'ds截图助手',

  // ---- 悬浮球能力 ----
  capture: () => ipcRenderer.send('start-capture'),   // 开始截图并送到网页
  openWeb: () => ipcRenderer.send('open-web'),        // 打开 DeepSeek 网页
  quit: () => ipcRenderer.send('quit-app'),           // 退出应用
  contextMenu: () => ipcRenderer.send('ball-context-menu'), // 右键 → 主进程弹原生菜单
  dragStart: (grab) => ipcRenderer.send('ball-drag-start', grab), // 开始拖动；grab=按下点（窗口内坐标），主进程用它当抓取偏移
  dragEnd: () => ipcRenderer.send('ball-drag-end'),               // 结束拖动（主进程吸附并保存位置）

  // ---- 截图遮罩能力 ----
  captureDone: (data) => ipcRenderer.send('capture-done', data),
  captureCancel: () => ipcRenderer.send('capture-cancel'),
  captureError: (msg) => ipcRenderer.send('capture-error', msg),
  onCaptureScreen: (cb) => subscribe('capture-screen', cb)
});
