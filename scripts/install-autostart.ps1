$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$runner = Join-Path $PSScriptRoot 'run-bridge.ps1'
$userName = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$taskName = 'QQGroupBot-Shiyan'
$action = New-ScheduledTaskAction -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' `
    -Argument ('-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $runner + '"') -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userName
$principal = New-ScheduledTaskPrincipal -UserId $userName -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
try {
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
        -Description 'QQ bot bridge: start at user login, recover crashes, keep the system awake while running.' -Force -ErrorAction Stop | Out-Null
    Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
    Write-Output ('Installed and started scheduled task: ' + $taskName)
} catch {
    # Some sessions cannot register tasks. Current-user Startup needs no elevation.
    $startup = [Environment]::GetFolderPath('Startup')
    if (-not $startup) { throw 'Could not locate the current-user Startup folder.' }
    New-Item -ItemType Directory -Path $startup -Force | Out-Null
    $shortcutPath = Join-Path $startup 'QQGroupBot-Shiyan.lnk'
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
    $shortcut.Arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $runner + '"'
    $shortcut.WorkingDirectory = $projectRoot
    $shortcut.WindowStyle = 7
    $shortcut.Description = 'QQ bot bridge: login startup, crash recovery, keep system awake.'
    $shortcut.Save()
    if (-not (Test-Path -LiteralPath $shortcutPath)) { throw 'Could not create login startup.' }
    Start-Process -FilePath $shortcut.TargetPath -ArgumentList $shortcut.Arguments -WorkingDirectory $projectRoot -WindowStyle Hidden
    Write-Output 'Task registration unavailable; current-user login Startup shortcut installed and supervisor launched.'
}
