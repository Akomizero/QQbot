# 肥鱼桌面原型 0.2.10

Windows x64 / WinForms + WebView2；前端 HTML、CSS、JS 和 .NET 运行时内置。

## 安装

解压分发包，使用 PowerShell 执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -ProjectRoot "E:\shiyan\qq-group-bot"
```

安装后双击“肥鱼桌面版”或已迁移的“启动肥鱼”。也可直接运行 Feiyu.exe，首次选择项目目录。
安装不启动服务，不改变 QQ 登录态。

## 使用

1. 双击EXE自动检查依赖并启动所需后台。已有未接管的旧服务时，只需确认接管一次；程序自动处理旧代码加载，不需要再点第二次启动。
2. “QQ 登录”内嵌专用 NapCat WebUI，从 `/webui/` 原生入口加载，可扫码、快速登录并查看 NapCat 状态；本机已有 WebUI 授权会自动接入，启用二次验证时在网页完成验证。网页不可用时可切换“备用二维码”。
3. 程序持续等待QQ初始化和授权OneBot握手，全部满足后才显示就绪并打开管理面板。未完成登录时保持等待和准确提示，不把进程存在视为成功。
4. 管理页在程序自己的WebView2窗口内打开，仍需原管理密码。诊断时可加`--no-start`只盘点，不自动启动。
5. 关闭窗口会先停止全部已管理后台。无法释放进程/端口时保留窗口，显示失败并允许重试。

新进程树使用专用 Windows Job；旧进程只在明确接管并核对 PID、创建时间、可执行路径后纳入退出保护。
不终止用户其他 QQ，也不接管共享浏览器。电脑真正休眠或关机时程序无法运行。

## 本机依赖与数据

- 系统 WebView2 Runtime、Node.js 20.9+。
- 选定项目的 src、scripts、node_modules（sharp 原生库、ws、undici、ffmpeg-static）。
- 项目 `.local/napcat/OneKey/NapCat.*.Shell` 的完整专用 NapCat/QQ。
- 视频 ASR、网页生图、浏览器会话等仍是可选外置组件。
- 密钥 `.env`、记忆/配置 `data`、NapCat 登录态及旧日志 `.local` 保留在本机项目目录，全部不进入分发包。
- 桌面偏好、进程身份回执、桌面日志、WebView2 profile：`%LOCALAPPDATA%\FeiyuBot`。

本原型是已有项目的桌面宿主，尚非把 Node、NapCat、Python 全部装好的全新机器安装包。

## 重建

构建机需要 .NET SDK 8.0.425。版本固定于 global.json，NuGet 锁定于 packages.lock.json。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build.ps1
# 已缓存依赖时可加 -Offline
```

分发只包含 Feiyu.exe、install.ps1、README.md、build-manifest.json。
manifest 记录 SDK、版本、输入摘要和分发文件 SHA256；构建不递归复制项目或私人数据。
尚未代码签名；分发前请核对哈希和来源。
