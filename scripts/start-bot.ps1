param([switch]$NoBrowser, [switch]$RepairDedicatedQQ)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$localRoot = Join-Path $projectRoot '.local'
$powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$entry = Join-Path $projectRoot 'src\main.js'
$runner = Join-Path $PSScriptRoot 'run-bridge.ps1'
New-Item -ItemType Directory -Path $localRoot -Force | Out-Null
$logFile = Join-Path $localRoot 'one-click-start.log'
function Write-StartLog([string]$Message) {
    if ((Test-Path -LiteralPath $logFile) -and (Get-Item -LiteralPath $logFile).Length -gt 64KB) {
        [System.IO.File]::WriteAllText($logFile, '')
    }
    Add-Content -LiteralPath $logFile -Value ([DateTimeOffset]::UtcNow.ToOffset([TimeSpan]::FromHours(8)).ToString('yyyy-MM-dd HH:mm:ss zzz') + ' ' + $Message)
}
function Show-StartMessage([string]$Message, [bool]$IsError = $false) {
    Add-Type -AssemblyName System.Windows.Forms
    $icon = if ($IsError) { [System.Windows.Forms.MessageBoxIcon]::Error } else { [System.Windows.Forms.MessageBoxIcon]::Information }
    [void][System.Windows.Forms.MessageBox]::Show($Message, '肥鱼 QQ 机器人', [System.Windows.Forms.MessageBoxButtons]::OK, $icon)
}
function Get-ConfiguredPort([string]$Name, [int]$Default) {
    $value = [Environment]::GetEnvironmentVariable($Name)
    $envFile = Join-Path $projectRoot '.env'
    # Read only the selected port values; never print or copy credentials.
    if ((-not $value) -and (Test-Path -LiteralPath $envFile)) {
        foreach ($line in [System.IO.File]::ReadLines($envFile)) {
            if ($line -match ('^\s*' + [regex]::Escape($Name) + '\s*=\s*(.*?)\s*$')) {
                $value = $Matches[1].Trim().Trim('"').Trim("'")
            }
        }
    }
    if (-not $value) { return $Default }
    $port = 0
    if (-not [int]::TryParse($value, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
        throw ('端口配置无效：' + $Name + '。请在本机配置中使用1到65535之间的整数。')
    }
    return $port
}
function Get-BridgeProcesses {
    return @(Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object {
        $_.CommandLine -and $_.CommandLine.Contains($entry)
    })
}
function Get-PanelState([int]$Port) {
    $workers = @(Get-BridgeProcesses)
    $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    $owned = @($listeners | Where-Object { $_.OwningProcess -in $workers.ProcessId })
    return [pscustomobject]@{ Ready = $owned.Count -gt 0; Occupied = $listeners.Count -gt 0 -and $owned.Count -eq 0 }
}
function Test-OneBotConnected([int]$Port) {
    $workers = @(Get-BridgeProcesses)
    return @((Get-NetTCPConnection -LocalPort $Port -State Established -ErrorAction SilentlyContinue) | Where-Object {
        $_.OwningProcess -in $workers.ProcessId
    }).Count -gt 0
}
function Get-RuntimeHealth {
    $path = Join-Path $localRoot 'bot-health.json'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    try {
        if ((Get-Item -LiteralPath $path).Length -gt 128KB) { return $null }
        $health = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
        $workers = @(Get-BridgeProcesses)
        $age = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [long]$health.updatedAt
        if ($health.version -ne 1 -or $health.pid -notin $workers.ProcessId -or $age -lt -2000 -or $age -gt 20000) { return $null }
        return $health
    } catch { return $null }
}
function Set-StartProgress([string]$Message) {
    Write-StartLog $Message
    if ($script:progressForm -and -not $script:progressForm.IsDisposed) {
        $script:progressLabel.Text = $Message
        $script:progressForm.Refresh()
        [System.Windows.Forms.Application]::DoEvents()
    }
}
function Wait-OneBot([int]$Port, [int]$Seconds = 30) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        if ($script:progressForm -and -not $script:progressForm.IsDisposed) { [System.Windows.Forms.Application]::DoEvents() }
        $health = Get-RuntimeHealth
        if ($health -and $health.startupComplete -eq $true -and $health.onebot.connected -eq $true) { return $true }
        if (-not $health -and (Test-OneBotConnected $Port)) { return $true }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    $lastHealth = Get-RuntimeHealth
    if ($lastHealth) { return $lastHealth.onebot.connected -eq $true }
    return Test-OneBotConnected $Port
}
function Start-ProjectNapCat([switch]$Repair, [int]$OneBotPort) {
    $oneKeyRoot = Join-Path $localRoot 'napcat\OneKey'
    if (-not (Test-Path -LiteralPath $oneKeyRoot -PathType Container)) {
        Write-StartLog 'Project NapCat bundle missing; bridge can still start.'
        return $false
    }
    $existingQQPaths = @(Get-CimInstance Win32_Process -Filter "name='QQ.exe'" | ForEach-Object { $_.ExecutablePath })
    $bundles = @(Get-ChildItem -LiteralPath $oneKeyRoot -Directory -Filter 'NapCat.*.Shell' | Sort-Object @{Expression={if ((Join-Path $_.FullName 'QQ.exe') -in $existingQQPaths) {0} else {1}}}, @{Expression={$_.LastWriteTime};Descending=$true})
    foreach ($bundle in $bundles) {
        $qqExe = Join-Path $bundle.FullName 'QQ.exe'
        $bootExe = Join-Path $bundle.FullName 'NapCatWinBootMain.exe'
        $hook = Join-Path $bundle.FullName 'NapCatWinBootHook.dll'
        $loadPath = Join-Path $bundle.FullName 'loadNapCat.js'
        $mainPath = Join-Path $bundle.FullName 'napcat.mjs'
        $patchPath = Join-Path $bundle.FullName 'qqnt.json'
        $requiredFiles = @($qqExe, $bootExe, $hook, $loadPath, $mainPath, $patchPath)
        if (@($requiredFiles | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) }).Count) { continue }
        # Use the dedicated bundled QQ, never the user's other QQ installations.
        $running = @(Get-CimInstance Win32_Process -Filter "name='QQ.exe'" | Where-Object {
            $_.ExecutablePath -and $_.ExecutablePath.Equals($qqExe, [StringComparison]::OrdinalIgnoreCase)
        })
        if ($running.Count -and -not $Repair) { Write-StartLog 'Dedicated QQ exists; OneBot connection not yet verified.'; return $true }
        if ($Repair) {
            if (Test-OneBotConnected $OneBotPort) { Write-StartLog 'Connection recovered; repair skipped.'; return $true }
            $ownedPaths = @($qqExe, $bootExe)
            $owned = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -in $ownedPaths })
            foreach ($item in $owned) {
                if (Test-OneBotConnected $OneBotPort) { return $true }
                $current = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $item.ProcessId) -ErrorAction SilentlyContinue
                if ($current -and $current.ExecutablePath -in $ownedPaths) { Stop-Process -Id $current.ProcessId -ErrorAction Stop }
            }
            Write-StartLog 'Explicit repair stopped only dedicated QQ/bootstrap; Node and unrelated QQ kept.'
            Start-Sleep -Milliseconds 800
        }
        $variables = @{
            NAPCAT_PATCH_PACKAGE = $patchPath
            NAPCAT_LOAD_PATH = $loadPath
            NAPCAT_INJECT_PATH = $hook
            NAPCAT_LAUNCHER_PATH = $bootExe
            NAPCAT_MAIN_PATH = $mainPath
            NAPCAT_WORKDIR = (Join-Path $localRoot 'napcat\bot-workdir')
        }
        $before = @{}
        try {
            foreach ($name in $variables.Keys) {
                $before[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
                [Environment]::SetEnvironmentVariable($name, $variables[$name], 'Process')
            }
            Start-Process -FilePath $bootExe -ArgumentList ('"' + $qqExe + '" "' + $hook + '"') -WorkingDirectory $bundle.FullName -WindowStyle Hidden | Out-Null
            Write-StartLog 'Dedicated NapCat/QQ launch requested; existing working directory retained.'
        } finally {
            foreach ($name in $before.Keys) { [Environment]::SetEnvironmentVariable($name, $before[$name], 'Process') }
        }
        return $true
    }
    Write-StartLog 'No complete dedicated NapCat bundle found.'
    return $false
}

$identity = [System.Security.Cryptography.SHA256]::Create()
try { $suffix = ([BitConverter]::ToString($identity.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($projectRoot.ToLowerInvariant())))).Replace('-', '').Substring(0, 16) }
finally { $identity.Dispose() }
$mutex = [System.Threading.Mutex]::new($false, ('Local\QQGroupBot-DesktopStart-' + $suffix))
$ownsMutex = $false
try {
    try { $ownsMutex = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { exit 0 }
    Add-Type -AssemblyName System.Windows.Forms
    $script:progressForm = New-Object System.Windows.Forms.Form
    $script:progressForm.Text = '启动肥鱼'
    $script:progressForm.Width = 580
    $script:progressForm.Height = 185
    $script:progressForm.StartPosition = 'CenterScreen'
    $script:progressLabel = New-Object System.Windows.Forms.Label
    $script:progressLabel.Left = 22
    $script:progressLabel.Top = 24
    $script:progressLabel.Width = 520
    $script:progressLabel.Height = 80
    $script:progressLabel.Text = '正在检查后台服务、QQ连接与功能状态，请稍候…'
    $script:progressForm.Controls.Add($script:progressLabel)
    $script:progressForm.Show()
    [System.Windows.Forms.Application]::DoEvents()
    if (-not (Test-Path -LiteralPath $runner -PathType Leaf) -or -not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw '启动文件不完整，请从项目目录重新安装桌面入口。' }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw '未找到 Node.js。请安装 Node.js 20.9 或更高版本后重试。' }
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\ws\package.json'))) { throw '项目依赖未安装。请先在项目目录运行 npm ci，再双击启动。' }
    $webPort = Get-ConfiguredPort 'QQBOT_WEB_PORT' 3000
    $onebotPort = Get-ConfiguredPort 'QQBOT_ONEBOT_PORT' 16700
    $state = Get-PanelState $webPort
    if ($state.Occupied) { throw ('管理页端口 ' + $webPort + ' 被其他程序占用。为避免影响其他程序，本次没有强制关闭它。') }
    $supervisors = @(Get-CimInstance Win32_Process -Filter "name='powershell.exe'" | Where-Object {
        $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($runner)
    })
    if (-not $supervisors.Count) {
        Start-Process -FilePath $powershellExe -ArgumentList ('-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $runner + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden | Out-Null
        Write-StartLog 'Background supervisor launch requested.'
    } else { Write-StartLog 'Background supervisor already running; kept existing process.' }
    Set-StartProgress '后台守护已检查；正在检查专用 NapCat / QQ。'
    if (-not (Test-OneBotConnected $onebotPort)) { $napcatAvailable = Start-ProjectNapCat -OneBotPort $onebotPort }
    else { $napcatAvailable = $true; Write-StartLog 'OneBot already connected; no QQ launch needed.' }
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    do {
        if ($script:progressForm -and -not $script:progressForm.IsDisposed) { [System.Windows.Forms.Application]::DoEvents() }
        $state = Get-PanelState $webPort
        if ($state.Occupied) { throw ('管理页端口 ' + $webPort + ' 被其他程序占用，请检查端口配置。') }
        if ($state.Ready) { break }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not $state.Ready) { throw ('bot 尚未启动完成。请查看：' + (Join-Path $localRoot 'bridge-managed.stderr.log')) }
    Set-StartProgress '管理页可用；正在等待真实 QQ / OneBot 连接，这一步未完成时 bot 尚未就绪。'
    $connected = Wait-OneBot -Port $onebotPort -Seconds 30
    if (-not $connected -and $napcatAvailable) {
        if ($script:progressForm -and -not $script:progressForm.IsDisposed) { $script:progressForm.Hide() }
        $repair = [bool]$RepairDedicatedQQ
        if (-not $repair) {
            $choice = [System.Windows.Forms.MessageBox]::Show("管理页已启动，但 QQ / OneBot 仍未连接，bot 尚不能接收群消息。`r`n`r`n如果专用 QQ 正在等待扫码，请先完成登录，再重新双击启动。`r`n如果 QQ 已登录但连接失效，点「重试」可仅重启本项目专用 QQ / NapCat；不重启 Node，不影响其他 QQ。点「取消」保留现有进程。", '肥鱼：QQ尚未连接', [System.Windows.Forms.MessageBoxButtons]::RetryCancel, [System.Windows.Forms.MessageBoxIcon]::Warning, [System.Windows.Forms.MessageBoxDefaultButton]::Button2)
            $repair = $choice -eq [System.Windows.Forms.DialogResult]::Retry
        }
        if ($repair) {
            Set-StartProgress '正在修复专用 QQ 连接；请完成出现的 QQ 登录步骤。'
            $napcatAvailable = Start-ProjectNapCat -Repair -OneBotPort $onebotPort
            $connected = Wait-OneBot -Port $onebotPort -Seconds 30
        }
    }
    $health = Get-RuntimeHealth
    $connected = if ($health) { $health.onebot.connected -eq $true } else { Test-OneBotConnected $onebotPort }
    $connectionText = if ($health -and $health.onebot.connected -eq $true) { '已建立授权 WebSocket 连接；QQ登录与收发未探测' } elseif ($connected) { '检测到TCP连接；旧进程未提供授权会话状态，QQ登录与收发未核实' } else { '未连接；bot尚不能接收群消息' }
    $lines = @('Node 管理页：可用', ('QQ / OneBot：' + $connectionText))
    $components = @()
    if ($health) {
        $components = @($health.components)
        $stateLabels = @{ 'starting'='初始化中'; 'ready'='当前连接可用'; 'listening'='监听可用'; 'waiting-qq'='等待OneBot'; 'started-unverified'='调度已启用，执行效果未验收'; 'configured-unverified'='配置/依赖存在，实际可用性未核实'; 'disabled'='未启用'; 'missing-dependency'='缺少配置或依赖'; 'failed'='异常'; 'stopped'='已停止' }
        foreach ($component in $components) {
            $label = $stateLabels[[string]$component.state]
            if (-not $label) { $label = [string]$component.state }
            $lines += ([string]$component.label + '：' + $label)
        }
        $fullReady = $health.coreReady -eq $true -and $health.onebot.connected -eq $true
        if (-not $fullReady) { $lines += '核心初始化或QQ连接尚未全部就绪，不能视为完整启动成功。' }
    } else {
        $fullReady = $false
        $lines += '当前进程尚未加载健康上报：只确认了端口/连接，维护任务与可选功能尚未核验。现有服务未被自动重启。'
    }
    if (-not $connected) { $lines += '下一步：完成专用QQ扫码/登录，或检查管理页的OneBot连接；必要时再次启动并选择修复专用QQ。' }
    @{version=1;at=[DateTimeOffset]::UtcNow.ToOffset([TimeSpan]::FromHours(8)).ToString('o');managementReady=$true;onebotConnected=$connected;coreReady=[bool]$fullReady;runtimeHealthAvailable=[bool]$health;components=$components} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $localRoot 'one-click-status.json') -Encoding utf8
    Write-StartLog ('Startup assessment: OneBot=' + $connected + '; coreReady=' + $fullReady + '; freshRuntimeHealth=' + [bool]$health)
    if ($script:progressForm -and -not $script:progressForm.IsDisposed) { $script:progressForm.Close() }
    if (-not $NoBrowser) { Start-Process -FilePath ('http://127.0.0.1:' + $webPort + '/#access') | Out-Null }
    Show-StartMessage ($lines -join "`r`n")
} catch {
    Write-StartLog 'One-click startup did not finish; displayed a local error message.'
    Show-StartMessage ($_.Exception.Message + "`r`n`r`n启动日志：" + $logFile) $true
    exit 1
} finally {
    if ($script:progressForm -and -not $script:progressForm.IsDisposed) { $script:progressForm.Dispose() }
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
