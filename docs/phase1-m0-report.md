# dsh-dstuber 阶段一 M0 报告（插件 + Live2D + Tauri 壳）

日期：2026-10-22
项目：`D:\projects\dsh-dstuber`（原名 dsh-pet）
目标：插件完整度与兼容性、Live2D 功能验证、Tauri 透明窗可行性。

## 1. 结论

- **插件可用**：`dsh-dstuber` 已以 bundle 安装进 `web` profile，Host、设置页 tab、页面浮层、事件桥、chat API 均实际注册。
- **Live2D 可用**：模型增强为 44 表情 / 8 动作；在 DSH 页面与 Tauri/WebView2 中都能加载。
- **Tauri 透明窗可行**：M0 窗口已跑起来，Live2D 在 WebView2/WebGL2 下完整自检通过。
- **仍需一次 DSH 重启**：修复后的 Host 代码（`/stage/` 重定向、configEditor 设置读写）尚未在 live 实例中生效；重启后即可在 DSH 内使用设置保存与浮层。

## 2. 验证矩阵

| 项 | 结果 | 证据 |
|---|---|---|
| Bundle 安装 / 启用 | 通过 | `plugin_manager` → `application: applied`，`include:dsh-dstuber` active |
| Config Schema / 设置读写 | 通过（修复后单测） | `configEditor` 读写、revision 冲突、key 脱敏；21 项单测 |
| DSH 事件桥 | 通过 | `session/event` / `agent/status` / `agent/assistant-stream`；健康接口能看到 3 个会话与当前工具 |
| 设置页 tab | 通过 | `settings.plugins.tab` occupants: `dsh-dstuber` active |
| 页面浮层 | 已注册 | `shell.overlay` occupants: `dsh-dstuber-overlay` active |
| 模型增强 | 通过 | `model3.augmented.json`：44 表情 / 8 动作 / LipSync=`ParamMouthOpenY` |
| 模型加载（Tauri） | 通过 | WebView2 Chrome/155，WebGL2，ANGLE D3D11，RTX 4070 |
| 表情 | 44/44 通过 | stage 自检报告 |
| 动作 | 7/7 通过 | stage 自检报告（修复 Idle 优先级后） |
| 口型 | 通过 | `ParamMouthOpenY` index 36，范围 0..1，帧内采样 1.0 |
| 状态映射 | 13/13 通过 | thinking/working/waiting/happy/excited/shy/sad/angry/confused/sleepy/error/success/idle |
| 渲染像素 | 通过 | 30,068 个非透明采样点，边界 92,180–568,644 |
| 帧率 | 约 164 FPS（当前机器） | WebView2 硬件加速 |
| 透明窗 / 无边框 | 待视觉确认 | client 尺寸 = window 尺寸 380×500，无标题栏/边框；WebGL alpha=true |
| 置顶 | 通过 | `WS_EX_TOPMOST` 置位 |
| 跳过任务栏 | 实现为 `ITaskbarList::DeleteTab` | ExStyle 仍含 AppWindow，但任务栏按钮由 DeleteTab 删除；待视觉确认 |
| 位置 | 通过 | 1707×1067 屏幕，窗口 380×500 @ 1303,519（右下 24/48 边距） |
| 自动拉起 / 崩溃重启 | 通过 | Host supervisor；手动杀 pid 后约 4s 自动重建（attempts=1） |
| 右键直接设置 | 通过 | 无 `#32768` 一级菜单；设置窗口 455×717 @863,301，桌宠 380×500 @1325,435，左侧约 8px 间距不遮挡；隐藏创建→定位→显示，无左上闪现 |
| 本地设置窗口 | 通过 | 440×680，`settings-ui-ready` 回执；不加载 8099，无“拒绝连接” |
| 缩放重排 | 通过 | 缩小后 stage 视口 286×376，模型显示 268.84×268.84，完整不裁切 |
| HUD 默认隐藏 | 通过 | 生产 URL 无 `hud`/`selftest`；壳额外剥离这两个参数 |
| 左键拖拽 | 事件通道已通，待手动确认 | 远程页发 `plugin:event|emit`；Rust 监听后 `start_dragging` |
| 字幕框 | 通过 | 默认 640×120 @1067,391；桌宠 380×500 @1303,519；上方 8px 间距，自动吸附；宽高可在设置调整 |
| 字幕边缘缩放 | 通过 | 左边缘拖 160px：宽 384→544；超限拖拽被限制在 1365px（1707 屏的 4/5） |
| 字幕缩放后重吸附 | 通过 | 右边缘向内拖 160px（640→480），松开约 200ms 后 x 101→181，重新居中对齐桌宠 |
| 字幕右键菜单 | 通过 | 原生菜单三项勾选：显示字幕 / 吸附桌宠 / 半透明背景；切换吸附后跟随/脱离桌宠 |
| 字幕设置页 | 通过 | 总设置新增“字幕”独立 tab：显示/吸附/半透明背景、方向、宽高、字号、不透明度、预览文本；本地加载回执正常 |
| 字幕尺寸约束 | 通过 | Rust + 原生窗口 min/max：最小 240×60，宽 ≤ 4/5、高 ≤ 1/2（逻辑像素） |
| 对话窗口 | 通过 | 480×668 客户端（默认 480×640），蓝白非透明；位于 @564,341，避开字幕 8px |
| 对话右键菜单/缩放 | 通过 | 原生菜单出现；左边缘拖 80px，宽 495→415 |
| 对话 SSE | 通过 | Host 同源 `/api/events` 连接；页面回执 sse-open（已移除诊断回执） |
| 对话设置页 | 通过 | 设置新增“对话”独立 tab：显示/吸附/方向/宽高/置顶/打开/清空 |

自检原始报告：`docs/m0-stage-report.json`。

## 3. 本轮发现并修复的问题

1. **`/stage/` 无限 302**：旧实现把 `/stage/` 重定向到 `/stage/?bg=grid`，路径不变导致循环，iframe 永远打不开。改为 `/stage` → `/stage/` 一次跳转；`/stage/` 直接返回 index，并加回归测试。
2. **旧版 `settings.describe` 跳过 include 行**：DSH 0.2.1-rc.2 的 `settings.describe()` 不返回 `include:` 包装条目，配置一直走 memory。改用官方 `configEditor.configuration()/edit()` 读写，支持 revision 冲突与 key 脱敏。
3. **Idle 动作优先级**：初始 Idle 用 NORMAL 优先级循环，导致后续 Gesture 同优先级被 MotionManager 拒绝（0/7）。Idle 改为 IDLE，自检手势用 FORCE。
4. **口型读取假象**：`coreModel.loadParameters()` 每帧末尾恢复参数，异步读取永远是 0。改为在 `beforeModelUpdate` 内写入后立即采样。
5. **WebView2 默认数据目录被拒**：`%LOCALAPPDATA%` 写入返回 os error 5。新增 `DSH_DSTUBER_DATA_DIR`，`.data_directory()` 固定到项目内 `.webview2`。
6. **link.exe 无法写系统 Temp**：LNK1104。构建时把 `TEMP/TMP` 指向项目内 `.tmp`。
7. **Rust 下载/安装**：static.rust-lang.org 卡住 → 清华镜像；用户目录 ACL 限制 → 项目内 `.cargo/.rustup`；SChannel 在沙箱内失败 → 构建时完整权限一次。
8. **多屏定位**：定位只用了 monitor 尺寸，没加 monitor 原点；已修复。
9. **DSH 重启后桌宠不回来**：壳原本靠手动启动，DSH 退出即消失。新增 Host `ProcessSupervisor`：插件激活后自动 spawn 壳、pid 文件防重复、退出后退避重启（0.5–5s，最多 5 次）、插件卸载/DSH 退出时 taskkill 进程树。已通过“杀壳后 4s 自动重建”验证。
10. **页面浮层左上角出现带边框缩小桌宠**：浮层组件没有挂载自己的 `<style>`，iframe 以浏览器默认 300×150 + 边框出现在 `shell.overlay` 层左上角（之前 450×225 的匿名自检报告正是它）。已在浮层内挂载样式；同时把 `pet.webOverlay` 默认改为 **false**，网页不再默认显示桌宠。
11. **右键弹出“无法访问此页面 127.0.0.1 拒绝连接”**：旧实现是 Tauri 的本地 `panel.html` 窗口，但 debug 构建按 `devUrl` 指向了未运行的 8099 开发服务器。已移除网页面板，改成右键直接打开本地打包设置窗口（取消一级原生菜单）+ 托盘，并删掉 `devUrl`。
12. **缩放后模型被裁切/缺失**：PIXI 的 `resizeTo: window` 与 Tauri `set_size` 存在竞态，`fit()` 有时用旧画布尺寸计算。改为显式 `renderer.resize`、`ResizeObserver` + 40ms 防抖重排，并在 Rust 改窗口后 eval `__pet.relayout()`；实测 380×500→285×375 后视口 286×376、模型 268.84×268.84 完整显示。
13. **右键设置窗口先出现在左上再闪现到桌宠旁**：窗口以默认位置可见创建，随后才 `position_settings` 移动。改为 `.visible(false)` 创建、定位完成后再 `show()`；已有窗口仅在隐藏时才显示，避免中间位置。

## 4. 已知限制 / 下一步

- **DSH 重启**：已重启一次并确认修复版 Host 生效（`configEditor` 设置保存、`/stage/` 正常）。后续 Host 代码改动可通过设置 PATCH 触发热重载，无需重启。
- **壳的启动方**：已由 Host supervisor 自动拉起（`shell.autoStart` 默认 true）。手动 `scripts/run-shell.ps1` 仍可用于调试。
- **壳协议**：尚无 WS、音频、口型实时联动、chat 中继到壳；M0 只验证窗口与渲染。
- **交互**：左键拖拽、右键直接设置窗口、托盘、本地设置窗口已接入；点击穿透、全局快捷键未接。需要关闭时用设置窗口“退出桌宠”或托盘退出；`Stop-Process` 会被 supervisor 自动重启（除非先关闭 `shell.autoStart`）。
- **视觉确认**：透明背景、任务栏是否隐藏需要你在桌面上看一眼；若透明失败，按交接书回退分层窗口/遮罩。
- **页面内浮层**：默认关闭；需要时在设置中开启（开启后固定在右下角、无 HUD）。
- **字幕**：当前显示预览文本，设置项和吸附状态保存在壳内存中，壳重启恢复默认；真实对话/TTS 文本接入、自动隐藏/逐字显示待下一阶段。字幕菜单含“显示字幕/吸附桌宠/半透明背景”三项；半透明背景默认开启，关闭即全透明。
- **对话窗口**：已接 Host `/api/chat` 与 `/api/events`，同一 Host 源；为不向当前活跃会话注入测试消息，未在自动测试中执行真实发送。窗口消息为纯文本、仅显示本次打开后的新回复，不加载历史、不渲染 Markdown/工具卡；默认可见但关闭后可用托盘恢复，设置/窗口状态在壳内存中。

## 5. 复现命令

```powershell
# 测试
node --test --test-isolation=none test/*.test.js

# 独立 stage
node scripts/serve-stage.mjs

# 构建 / 运行桌面壳
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-shell.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-shell.ps1
```

关闭壳：`Stop-Process -Name dsh-dstuber-shell -Force`。
