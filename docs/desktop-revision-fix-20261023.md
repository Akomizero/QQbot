# 桌面源码版本误报修复：0.2.1

日期：2026-10-23（Asia/Shanghai）。本轮不停止、重启或接管任何真实服务。

## 根因与修复

桌面控制器实际由 Windows PowerShell5.1执行，而先前手动核对使用PowerShell7。两者的`Sort-Object Name -CaseSensitive`使用不同排序实现，对连字符/点号的排序不同，例如`commands.js`和`command-store.js`、`llm.js`和`llm-settings-store.js`、`search.js`和`search-intent.js`。

因此同一批源码在PS5.1中得到`7dbc4a9d336015ce45224b300bbfc1cedcf221a2fd40842d683b9ee2d6858a8e`，PS7/Node则得到`33a11a3ec3250d10b70c009fb88266520654f025505ca3f8743d517351bc7412`。这不是旧bot没加载新代码。

`desktop/control.ps1`改用`[Array]::Sort($names,[StringComparer]::Ordinal)`，与Node默认的UTF-16序号排序一致；扩展名也使用大小写敏感的Ordinal匹配。未修改Node业务源码或其运行摘要。

## 复核

- PS5.1、PS7、Node三个结果均为`33a11a3ec3250d10b70c009fb88266520654f025505ca3f8743d517351bc7412`。
- 当前窗口使用的缓存控制脚本已仅替换Revision函数，并在原目录保留`.before-ordinal-20261023`副本。
- 实际缓存脚本执行Status返回`runtimeCurrent=true`、`freshHealth=true`，worker PID123800；OneBot仍未连接，不能混同为版本问题。
- 当前窗口PID126480与worker PID123800均保留，没有重启QQ或改变登录态。

## 持久交付

已构建并旁路安装0.2.1，当前0.2.0窗口不关闭、不替换运行中的EXE。桌面“启动肥鱼”和“肥鱼桌面版”均指向`%LOCALAPPDATA%\FeiyuBot\app\0.2.1\Feiyu.exe`，下次正常启动会使用新版本。

0.2.1 EXE SHA256：`3352c046ad850765e86e5b8144ffe78ae7584c3e6b561fce06b95ae8656f5a82`。安装文件与构建文件一致，manifest输入/产物摘要全匹配。此补丁做了跨运行时摘要及当前真实只读Status核对，没有重新执行此前0.2.0的7项完整隔离流程，也没有做真实QQ收发验证。

## 旧登录启动快捷方式备份

已确认文件存在，内容仍只指向本项目`scripts/run-bridge.ps1`；原Startup目录中的同名入口已不存在：

```text
[本机绝对路径已脱敏]
```

本轮只核对该备份，未移动、恢复或执行它。`.disabled.lnk`仍是可执行的Windows快捷方式，不能为了查看而双击启动。
