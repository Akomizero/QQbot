# 桌面一键启动肥鱼

> 后续入口已改为 Windows EXE + 内置管理页原型，见[桌面 EXE 说明](desktop-exe-prototype-20261023.md)。下文保留旧 PowerShell 启动器的历史行为；不要用旧安装脚本覆盖已迁移的桌面入口。新程序关闭窗口会停止已管理后台，不采用旧守护常驻语义。

**更新日期：** 2026-10-23（Asia/Shanghai）。本轮是本地入口与健康检查改动，未执行新启动器、未重启当前服务。

安装入口：在项目目录执行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-desktop-launcher.ps1`。安装器会在当前用户桌面和项目目录各创建「启动肥鱼」快捷方式，不运行启动器、不停止服务，也不修改登录自启任务。同名的其他快捷方式会保留。

双击「启动肥鱼」后：

1. 检查本项目后台守护与管理端口，缺少守护时后台启动；已有 bot 实例不重启。
2. 若 OneBot 尚未连接，检查本项目 OneKey 目录内的专用 NapCat/QQ；仅在其未运行时启动。继续使用 `.local/napcat/bot-workdir` 中的现有配置，不打印或复制凭据，不影响其他 QQ 安装。
3. 管理页最多等待45秒，再对真实 OneBot 状态和主进程健康快照最多等待30秒；管理页可打开不等于QQ已接入。打开配置中的本机管理页「群与权限」，配置端口变化后仍使用新端口。登录失效时由用户在QQ完成扫码/登录。
4. 连续双击由项目级互斥量防止并发启动；现有后台守护还会阻止重复的 bot 进程。端口被其他程序占用时提示错误，不强制结束其他程序。

## 分层状态与旧进程

新版主进程写入 `.local/bot-health.json`。启动器核对快照版本、当前本项目worker的PID和20秒新鲜度，分别报告管理服务、OneBot和核心初始化状态。旧进程没有该快照时，只能确认观察到的页面/连接状态，不能宣称本轮新功能已加载；退出后遗留或过期的快照也不算就绪证据。启动器不会为取得新快照自动重启已有bot。

健康快照的OneBot连接只证明token授权的本机WebSocket为OPEN，不证明QQ已登录或消息动作成功；旧进程没有快照时，TCP连接更只能作为连接线索。健康状态不验证模型、搜索或浏览器工具能否成功调用，也不证明知识维护、补发或视频发现已经实际完成一轮任务。组件明细、故障顺序和验收表见[启动组件说明](startup-components-20261023.md)。

## QQ未连接时的显式修复

常规断连会显示重试/取消提示：QQ正在等扫码时先完成登录；已经登录却仍失效时，用户可显式选择重试，只修复本项目专用QQ。取消则不动QQ。启动器不会按进程名批量结束所有QQ；已有真实OneBot连接时不重启专用QQ。

也可在项目目录明确调用修复参数：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/start-bot.ps1 -RepairDedicatedQQ
```

此参数表示用户主动请求修复专用QQ；不用于强制更新bot代码。修复后再等待最多30秒，仍未就绪会说明当前状态，不无限重试。

需要保留后台启动但不开管理页时：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/start-bot.ps1 -NoBrowser
```

## 日志和运行限制

正常启动不保留命令窗口。启动日志为 `.local/one-click-start.log`，守护日志为 `.local/bridge-supervisor.log`，bot错误日志为 `.local/bridge-managed.stderr.log`。关闭管理网页不会停止后台bot；停止仍使用已有 `scripts/stop-bridge.ps1`。

这里的“一键”指启动已安装的本机程序，不代替首次依赖安装、QQ登录、模型配置或系统运行。系统真正休眠、关机后本机 bot 无法工作；运行期间沿用既有守护的自动休眠抑制行为。

本机桌面和项目启动快捷方式已安装；健康检查与显式专用QQ修复为本轮本地代码改动。验收范围只包括语法/目标路径及实现静态审阅，没有运行测试、执行新启动器、重启现有服务或发布GitHub。此前本地尚未部署的视觉记忆和转发回复源码保持原状；将来进程停止后再启动时，会加载当时磁盘上的代码，具体生效仍须核对当前快照与运行效果。
