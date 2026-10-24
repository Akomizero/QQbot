$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$startScript = Join-Path $PSScriptRoot 'start-bot.ps1'
if (-not (Test-Path -LiteralPath $startScript -PathType Leaf)) { throw 'The one-click startup script is missing.' }
$powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $startScript + '"'
$desktop = [Environment]::GetFolderPath('Desktop')
if (-not $desktop) { throw 'The current-user Desktop folder could not be located.' }
$shell = New-Object -ComObject WScript.Shell
$node = Get-Command node -ErrorAction SilentlyContinue
foreach ($folder in @($desktop, $projectRoot)) {
    $index = 0
    do {
        $name = if ($index -eq 0) { '启动肥鱼.lnk' } else { '启动肥鱼（' + $index + '）.lnk' }
        $path = Join-Path $folder $name
        if (-not (Test-Path -LiteralPath $path)) { break }
        $existing = $shell.CreateShortcut($path)
        if ($existing.TargetPath -eq $powershellExe -and $existing.Arguments -eq $arguments) { break }
        $index++
    } while ($index -lt 100)
    if ($index -ge 100) { throw 'No unused shortcut name was available; existing shortcuts were preserved.' }
    $shortcut = $shell.CreateShortcut($path)
    $shortcut.TargetPath = $powershellExe
    $shortcut.Arguments = $arguments
    $shortcut.WorkingDirectory = $projectRoot
    $shortcut.WindowStyle = 7
    $shortcut.Description = '启动肥鱼 QQ 机器人和专用 NapCat，打开本机管理页；已有实例不会重启。'
    if ($node) { $shortcut.IconLocation = $node.Source + ',0' }
    $shortcut.Save()
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'The shortcut could not be saved.' }
    Write-Output $path
}
