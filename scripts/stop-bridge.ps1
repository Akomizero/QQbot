$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$runner = Join-Path $projectRoot 'scripts\run-bridge.ps1'
$entry = Join-Path $projectRoot 'src\main.js'
foreach ($process in @(Get-CimInstance Win32_Process -Filter "name='powershell.exe'")) {
    if ($process.ProcessId -ne $PID -and $process.CommandLine -and $process.CommandLine.Contains($runner)) {
        Stop-Process -Id $process.ProcessId -ErrorAction Stop
    }
}
foreach ($process in @(Get-CimInstance Win32_Process -Filter "name='node.exe'")) {
    if ($process.CommandLine -and $process.CommandLine.Contains($entry)) { Stop-Process -Id $process.ProcessId -ErrorAction Stop }
}
Write-Output 'This project bot bridge and supervisor stopped. Login startup remains installed.'
