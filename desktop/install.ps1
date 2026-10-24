param([string]$ProjectRoot)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
if(-not $ProjectRoot){
    $picker=New-Object Windows.Forms.FolderBrowserDialog
    $picker.Description='选择已有肥鱼项目目录（包含 src/main.js），不移动密钥、记忆或 QQ 登录态。'
    if($picker.ShowDialog() -ne [Windows.Forms.DialogResult]::OK){exit 0}
    $ProjectRoot=$picker.SelectedPath
    $picker.Dispose()
}
$ProjectRoot=(Resolve-Path -LiteralPath $ProjectRoot).Path
if(-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'src\main.js'))){throw '此目录不是完整的肥鱼项目。'}
$exe=Join-Path $PSScriptRoot 'Feiyu.exe'
$manifestPath=Join-Path $PSScriptRoot 'build-manifest.json'
if(-not (Test-Path -LiteralPath $exe) -or -not (Test-Path -LiteralPath $manifestPath)){throw '请从已构建的 dist/版本 目录安装。'}
$manifest=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if($manifest.version -notmatch '^\d+\.\d+\.\d+$'){throw '分发版本无效。'}
foreach($file in $manifest.files){
    if($file.file -notin @('Feiyu.exe','install.ps1','README.md')){throw '分发包包含非预期文件。'}
    if((Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $file.file) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256){throw ('文件校验失败：'+$file.file)}
}
$installRoot=Join-Path $env:LOCALAPPDATA ('FeiyuBot\app\'+$manifest.version)
New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
Copy-Item -LiteralPath $exe -Destination (Join-Path $installRoot 'Feiyu.exe') -Force
Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $installRoot 'build-manifest.json') -Force
$shell=New-Object -ComObject WScript.Shell
$desktop=[Environment]::GetFolderPath('Desktop')
# Migrate only our exact previous shortcut; preserve unrelated same-named entries.
$old=Join-Path $desktop '启动肥鱼.lnk'
if(Test-Path -LiteralPath $old){
    $shortcut=$shell.CreateShortcut($old)
    $oldEntry=Join-Path $ProjectRoot 'scripts\start-bot.ps1'
    $wasScript=$shortcut.Arguments -and $shortcut.Arguments.Contains($oldEntry)
    $wasDesktop=$shortcut.TargetPath.StartsWith((Join-Path $env:LOCALAPPDATA 'FeiyuBot\app\'),[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($shortcut.TargetPath) -eq 'Feiyu.exe' -and $shortcut.Arguments -eq ('--project "'+$ProjectRoot+'"')
    if($wasScript -or $wasDesktop){
        $backup=Join-Path $env:LOCALAPPDATA ('FeiyuBot\legacy-shortcut-'+[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+'.lnk')
        Copy-Item -LiteralPath $old -Destination $backup
        $shortcut.TargetPath=Join-Path $installRoot 'Feiyu.exe';$shortcut.Arguments='--project "'+$ProjectRoot+'"';$shortcut.WorkingDirectory=$ProjectRoot;$shortcut.WindowStyle=1;$shortcut.IconLocation=$shortcut.TargetPath+',0';$shortcut.Description='肥鱼桌面控制台；关窗停止已管理后台。';$shortcut.Save()
    }
}
$path=Join-Path $desktop '肥鱼桌面版.lnk'
if(Test-Path -LiteralPath $path){
    $existing=$shell.CreateShortcut($path)
    if(-not $existing.TargetPath.StartsWith((Join-Path $env:LOCALAPPDATA 'FeiyuBot\app\'),[StringComparison]::OrdinalIgnoreCase)){throw '桌面已有同名的其他快捷方式，请先另行命名。'}
}
$shortcut=$shell.CreateShortcut($path);$shortcut.TargetPath=Join-Path $installRoot 'Feiyu.exe';$shortcut.Arguments='--project "'+$ProjectRoot+'"';$shortcut.WorkingDirectory=$ProjectRoot;$shortcut.WindowStyle=1;$shortcut.IconLocation=$shortcut.TargetPath+',0';$shortcut.Description='内置管理面板；关窗停止所管理的后台服务。';$shortcut.Save()
Write-Output $path
Write-Output '已安装桌面 EXE。没有启动、停止、接管任何服务，也没有改变 QQ 登录态。'
