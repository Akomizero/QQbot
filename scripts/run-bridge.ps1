$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$localRoot = Join-Path $projectRoot '.local'
New-Item -ItemType Directory -Path $localRoot -Force | Out-Null
$identity = [System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($projectRoot.ToLowerInvariant()))
$suffix = ([BitConverter]::ToString($identity)).Replace('-','').Substring(0,16)
$mutex = [System.Threading.Mutex]::new($false, ('Local\QQGroupBot-' + $suffix))
$ownsMutex = $false
$logFile = Join-Path $localRoot 'bridge-supervisor.log'
function Write-SupervisorLog([string]$Message) {
    if ((Test-Path -LiteralPath $logFile) -and (Get-Item -LiteralPath $logFile).Length -gt 1MB) {
        [System.IO.File]::WriteAllText($logFile, '')
    }
    Add-Content -LiteralPath $logFile -Value (([DateTime]::UtcNow.AddHours(8).ToString('yyyy-MM-dd HH:mm:ss')) + ' +08:00 ' + $Message)
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class QQBotPower {
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern uint SetThreadExecutionState(uint flags);
}
'@
try {
    try { $ownsMutex = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { exit 0 }
    if ([QQBotPower]::SetThreadExecutionState(2147483649) -eq 0) { throw 'Could not request system wakefulness.' }
    Write-SupervisorLog 'Supervisor started; automatic system sleep is inhibited while running.'
    while ($true) {
        # Existing instances are observed rather than terminated. Never touch QQ or NapCat.
        $bridgeProcesses = @(Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object {
            $_.CommandLine -and $_.CommandLine.Contains((Join-Path $projectRoot 'src\main.js'))
        })
        if ($bridgeProcesses.Count -gt 0) {
            Start-Sleep -Seconds 10
            continue
        }
        $child = Start-Process -FilePath $nodeExe -ArgumentList 'src/launcher.js' -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $localRoot 'bridge-managed.stdout.log') -RedirectStandardError (Join-Path $localRoot 'bridge-managed.stderr.log')
        Write-SupervisorLog ('Bridge launched; launcher PID=' + $child.Id)
        $child.WaitForExit()
        Write-SupervisorLog 'Bridge exited; retrying after 5 seconds.'
        Start-Sleep -Seconds 5
    }
} finally {
    if ($ownsMutex) {
        [void][QQBotPower]::SetThreadExecutionState(2147483648)
        $mutex.ReleaseMutex()
    }
    $mutex.Dispose()
}
