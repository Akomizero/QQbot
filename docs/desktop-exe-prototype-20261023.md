# 肥鱼 Windows 桌面原型 0.2.0

最新交付为[0.2.2单次启动与扫码流程](desktop-startup-022-20261023.md)，桌面入口已更新。下文保留最初0.2.0原型的范围和历史说明。

日期：2026-10-23（Asia/Shanghai）。本方案替代仅以 PowerShell 快捷方式启动的入口。

最终构建、7项隔离验收、桌面入口迁移和真实QQ未操作的边界见[验证与安装记录](desktop-exe-verification-20261023.md)。

## 现状盘点与技术选择

| 组件 | 现有实现 | 原型处理 |
|---|---|---|
| 管理前端 | `public/index.html`、`app.js`、`styles.css`；同源 `/api/*`，管理密码会话 | 三个静态文件嵌入 EXE；WebView2 拦截静态请求从内置资源返回，API 仍走已核实的本项目回环端口。保留登录与服务端权限检查 |
| Node | ESM、Node ≥20.9；launcher 执行 main；ws、undici、sharp | 运行文件、Node 和依赖外置，独立启动/恢复；不能只把 JS 放进通用单文件打包器就声称所有功能可用 |
| 图片/视频 | sharp 的平台原生库；ffmpeg-static 可执行文件（本机约83MB） | 按项目 node_modules 定位，不混入用户数据；ASR 的 Python、模型另装 |
| NapCat/QQ | 专用 Shell 目录内 QQ、Boot、Hook DLL、loadNapCat.js、napcat.mjs、qqnt.json 与配套依赖 | 检查完整专用安装；保留原工作目录/登录态。启动使用可见窗口，显示窗口按钮只恢复此专用 QQ 的窗口 |
| 可选功能 | Python/ASR、模型专用出口、ChatGPT 网页辅助程序、已有浏览器会话 | 展示健康快照与依赖状态；不下载安装、不探测付费服务；共享浏览器不接管、不结束 |
| 持久数据 | 项目 `.env`、`data`、`.local` | 原位保留于用户本机项目；不嵌入、复制进 EXE/分发包 |

选择 **.NET 8 WinForms + WebView2**。本机已有构建 SDK 和系统 WebView2，适合 Windows 原生登录窗口、进程 Job、Win32 路径和时间身份核实。Electron 也能承载前端，但需要另一套 Chromium/Electron 依赖；Tauri 需要新增 Rust 构建链。此选择不声称 EXE 体积很小：当前自包含发布约163MB，包含 .NET，系统 WebView2、Node/NapCat仍外置。

WebView2 使用独立本地 profile，不复用 Edge 的登录态。官方 API 支持指定用户数据目录：[Microsoft 文档](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2environment.createasync)。SDK 固定为 [1.0.3537.50](https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.3537.50)，构建 SDK 固定8.0.425，NuGet依赖有锁文件。

## 原型入口与版本

- 开发源码：`desktop/`。
- 构建：`desktop/build.ps1`，缓存齐全时可加 `-Offline`。
- EXE：`desktop/dist/0.2.0/Feiyu.exe`。
- 分发：`desktop/dist/Feiyu-Desktop-0.2.0-win-x64.zip`。
- 安装：在分发目录运行 `install.ps1 -ProjectRoot <现有项目目录>`。
- 安装位置：`%LOCALAPPDATA%\FeiyuBot\app\0.2.0`。
- 安装后有“肥鱼桌面版”；旧“启动肥鱼”仅在确认为本项目的旧脚本入口时备份并切换至EXE。安装不启动/停止服务，也不改变登录态。
- 分发只允许 `Feiyu.exe`、`install.ps1`、`README.md`、`build-manifest.json`，不递归复制项目。
- manifest 记录版本、SDK、输入文件摘要、前端摘要、EXE/安装器/说明的SHA256。输入相同且依赖锁定时可重复生成；压缩包构建时间不同，不承诺ZIP逐字节一致。
- 本原型未做代码签名；不宣称是已经包含Node/NapCat/Python的全新机器完整安装包。

## 启动和接管

1. 打开窗口仅盘点，不自动修复或改变QQ登录态。
2. 每个项目一个窗口；读取旧主进程、守护、专用QQ/NapCat、端口和健康快照。
3. 发现旧服务必须明确接管。接管登记PID、创建时间、可执行文件路径，停用仅引用本项目runner的旧登录启动动作，避免退出后被旧守护重启。
4. 接管不冒充版本升级；旧 Node 无健康或源码摘要不符时显示“重启 bot”动作。重启只停已登记的 bot/辅助进程，不退出QQ。
5. 启动新的Node launcher和专用QQ；QQ/Boot以可见窗口启动。原隐藏实例若无窗口，明确提示使用“重启专用 QQ”，不重复悄悄打开QQ。
6. 新鲜健康需要匹配工作进程、启动时间、20秒有效期。运行版本使用所有 `src/*.js` 内容摘要；与磁盘版本分别对照。
7. `coreReady`、OneBot授权WebSocket、模型/搜索配置存在分别显示。未调用模型、搜索或QQ消息API，不能以进程存在推断登录/收发成功。
8. 所有服务恢复按钮只作用于已创建/明确接管的进程；未接管时拒绝自动处理。端口归外部程序时显示阻塞，不杀占用者。

## 关闭主窗口是强制退出

没有托盘继续运行模式，也没有“关窗但保留自己后台”的选项。

- 未接管但发现旧项目服务：关窗弹出“接管并停止 / 留在程序中”，默认优先停止；取消只留在窗口。
- 无法核实归属/无法释放端口：保留窗口并说明，不终止其他程序。
- 先停已登记的旧 supervisor，防止其重建Node。
- 新Node先通过随机命名、随机能力令牌的本机命名管道收到关闭请求，进入既有停止流程，关闭记忆/恢复/发现调度、桥接、模型连接/专用出口、管理HTTP服务。
- 15秒未退出时，再核对登记进程的PID、创建时间和精确路径，仅对这些进程做有界强制停止；旧Node没有管道时使用这个回退。
- 专用QQ先请求窗口正常关闭，再停止仍存活的已登记QQ/NapCat子进程。绝不按全局进程名结束QQ，不使用KillQQ.bat，不操作其他安装目录的QQ。
- 尝试将控制器及后代纳入专用Windows Job，提供快速退出bootstrap后代与异常退出保护。外层Job或旧进程既有Job导致系统拒绝时，界面明确显示身份回执回退，正常退出仍逐个停止并检查归零，不因加入Job失败跳过退出流程。内置WebView2若由Runtime自带Job限制，则用核心API取得的独立profile浏览器PID、创建时间和路径核实关闭，不接触用户Edge会话。
- 停止回执要求已登记进程归零、管理/OneBot监听端口释放，另检查Job剩余进程；任一失败窗口保留并允许重试。
- 接管回执、能力令牌与桌面日志存于 `%LOCALAPPDATA%\FeiyuBot\projects\<项目摘要>`；不返回到前端JS，不进分发包。

## 验收场景

| 场景 | 验收点 |
|---|---|
| 干净启动 | 状态逐项出现，管理页在程序内，未使用外部浏览器承载；完整服务未就绪不显示全绿 |
| 旧版后台 | `needsTakeover=true, managed=false, ownedCount=0` 时关窗必须要求接管并停止或留在窗口；不可直接退出 |
| 明确接管 | 记录进程身份；停用仅本项目旧登录启动；再次关闭释放原有服务 |
| QQ未登录 | 可见专用QQ/Boot；可恢复的登录窗口能够显示；无窗口给出专用重启操作 |
| bot旧版本 | 新鲜健康不存在或摘要不同有明确提醒；只重启bot加载源码，QQ保持原登录态 |
| 正常退出 | 优雅关闭回执、端口释放、已登记子进程归零、Windows Job归零、内置WebView2退出 |
| 停止失败 | 窗口不消失，列出失败动作/组件并能重试 |
| 干净重启 | 关闭后再次启动无旧监听、无旧子进程、无重复守护 |
| 外部QQ保护 | 对照其他QQ的PID/创建时间，启动/停止/修复均不改变它们 |
| 分发检查 | 白名单4文件；manifest输入和产物摘要一致；不含.env、记忆、登录态或日志 |
| 桌面入口 | 原快捷方式备份存在；TargetPath指向已安装EXE；从图标启动的进程是Feiyu.exe |

隔离验证脚本 `desktop/verify-isolated.ps1` 使用随机本地目录、两个临时回环端口、伪Node服务和伪辅助进程；不运行NapCat、不调用真实模型/搜索/QQ。它可验证旧进程识别/接管、内嵌前端执行、退出清理、优雅管道与干净重启。真实扫码、专用QQ重启和群消息收发须单独交互验收，不能用隔离验证冒充。
