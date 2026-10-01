# ds截图助手

> 按一下快捷键（默认 `Alt+A`）框选屏幕 → 图片自动送进 DeepSeek 网页的输入框 → 窗口自动跳出来。
> 接着直接在网页里打字提问、发送、看回答。

---

## 设计取舍（重要）

这个工具**只做一件事**：把截图塞进 DeepSeek 网页，然后把网页窗口推到你面前。

**不做的事**：不代填问题、不点发送、不抓回答、不做提问模板、不存历史。
原因很直接——那些自动化才是"等待回答超时""发送没生效"这类问题的来源。
发送和对话交给官方网页最稳，也不会因为网页改版而失效。

## 功能

| 能力 | 说明 |
| --- | --- |
| 悬浮球 | 常驻桌面，可拖拽、松手自动贴边；左键=截图并送到网页，右键=菜单 |
| 全局快捷键 | `Alt+A` 截图并送到网页；`Alt+Q` 只打开网页窗口（都带冲突自动回退） |
| 框选截图 | 多屏合并、混合 DPI 精确定位；选区可拖动、双击全屏、方向键微调 |
| 自动送图 | 框选完成后走 CDP 把图片写进网页的文件上传框（等价于手动选文件） |
| 自动跳转 | 网页窗口自动弹出并聚焦，光标落在输入框，直接打字即可 |
| 登录态持久化 | 独立 session 分区，登录一次长期有效 |
| 系统托盘 | 托盘菜单可直接截图 / 打开网页 / 退出 |

## 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `Alt+A` | 截图并送到 DeepSeek 网页 |
| `Alt+Q` | 打开 DeepSeek 网页窗口 |
| 截图时 `Enter` / `Esc` | 确认 / 取消 |
| 截图时 `双击` / `方向键` | 全屏选区 / 微调选区（`Shift` 加速） |

快捷键若被占用会自动尝试备选组合（截图备选 `Alt+Shift+D`，打开网页备选 `Alt+D`）。
可以在 `%APPDATA%\ds截图助手\settings.json` 里改 `shortcutCapture` / `shortcutOpen`。

## 快速开始

```bash
npm install          # 安装依赖（electron）
npm start            # 运行
```

首次使用：按 `Alt+A` 截图 → 弹出的网页窗口里登录 DeepSeek 账号（只需一次）→ 再按一次 `Alt+A`，
图片就会自动出现在输入框里。

## 打包

打包依赖（`electron-packager` / `electron-builder`）已在 2026-10-01 的工作区瘦身中移除
（约 350 个包、274 MB）。本项目日常用 `npm start`、`启动ds截图助手.bat` 或桌面快捷方式运行，
不需要打包，所以默认不带这套工具链。

需要重新打包时：

1. `npm i -D electron-packager electron-builder`
2. 把 `pack` / `dist` 脚本与 `build` 配置从 `handoff.md` §7 拷回 `package.json`（原文已存档在那里）

```bash
npm run icons        # 重新生成图标（可选，图标已随仓库提供）
```

## 验证

```bash
npm test             # 冒烟：配置/几何/源码一致性/图标（28 项，无需 GUI）
```

需要 Electron 的测试：

```bash
npm run test:drag    # 拖动链路：跟随循环 + 页面阈值判定 + 右键菜单（用合成鼠标事件，无需手动拖）
npm run test:inject  # 关键路径端到端：图片真的进了 file input

# 界面渲染自检，截图输出到 preview/shots/
node_modules\electron\dist\electron.exe tools\render-check.js --list
node_modules\electron\dist\electron.exe tools\render-check.js --scene ball
```

> 跑这些测试前如果当前 shell 里有 `ELECTRON_RUN_AS_NODE=1`，
> Electron 会以 Node 模式启动、`require('electron').app` 是 `undefined`。
> 先 `Remove-Item Env:\ELECTRON_RUN_AS_NODE` 再跑。

## 目录结构

```
src/
  main.js              主进程：快捷键、托盘、原生右键菜单、IPC、生命周期
  preload.js           白名单 API 桥
  ball.html            悬浮球：单击=截图，按住拖动=跟随鼠标（右键菜单走主进程原生菜单）
  capture.html         全屏截图遮罩：多屏合并、框选、裁剪压缩
  lib/
    webwin.js          DeepSeek 网页窗口：登录检测、图片注入、弹到前台
    windows.js         悬浮球（含跟随拖动）/ 截图遮罩 / 托盘的创建与显隐
    config.js          配置读写与容错合并（settings.json）
    capture.js         多屏截图数据准备（混合 DPI 合并）
    geometry.js        纯函数几何：悬浮球位置、靠边吸附、抓取偏移与跟随（可单测）
    icons.js           图标加载与兜底
tools/
  smoke-test.js        冒烟测试（配置/几何/源码一致性/图标）
  drag-test.js         拖动链路测试（跟随循环、页面阈值、右键菜单；用合成鼠标事件）
  inject-test.js       关键路径端到端测试（图片真的进了 file input）
  render-check.js      界面渲染自检（离屏截图）
  make-icons.js        零依赖图标生成器（PNG 编码 + 超采样绘制 + 自检）
  probe-dom.js         网页结构探测器（注入失败时用来定位真实选择器）
build/                 生成的应用图标与托盘图标
preview/               测试产出（渲染自检截图、拖动测试报告，可随时删除）
```

## 图片注入是怎么做的

通过 Chrome DevTools Protocol 把文件直接写进网页的 `input[type=file]`，
再让页面自己派发 `change` 事件——等价于用户手动选择文件：

```js
await dbg.sendCommand('DOM.setFileInputFiles', { nodeId, files: [tmpFile] });
```

网页改版导致注入失败时，运行结构探测器把真实选择器导出来：

```bash
node_modules\electron\dist\electron.exe tools\probe-dom.js --full
```

结果写入 `probe-result.txt`，其中「文件上传框」「输入框形态」两段就是要看的选择器，
改 `src/lib/webwin.js` 顶部的 `SELECTORS` 即可。

## 数据位置

```
%APPDATA%\ds截图助手\settings.json          快捷键等配置
%APPDATA%\ds截图助手\logs\main.log          主进程日志（快捷键、拖动、菜单；从快捷方式启动时唯一的取证途径）
%APPDATA%\ds截图助手\logs\webagent.log      网页注入日志（排查注入失败用）
%APPDATA%\ds截图助手\Partitions\deepseek-web\   网页版登录态
```

卸载 / 清理：删除该目录即可，不影响其它软件。

## 已知限制

- 图片注入依赖 DeepSeek 网页版的 DOM 结构，官方大改版后可能需要更新选择器
  （不会影响本机文件，日志里会有 `注入图片失败` 记录）。
- 需要 DeepSeek 账号；若网页版提示「使用环境异常」，那是官方侧的风控，程序无法绕过。
- 首次登录必须手动完成（不代管账号密码）。

## License

MIT
