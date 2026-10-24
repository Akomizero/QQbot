param(
    [Parameter(Mandatory=$true)][string]$ProjectRoot,
    [ValidateSet('Status','Preflight','Start','Advance','RefreshLogin','LoginWeb','Takeover','ShowLogin','RestartBot','RestartQQ','Stop')][string]$Action='Status',
    [Parameter(Mandatory=$true)][int]$OwnerPid
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path.TrimEnd('\')
$entry = Join-Path $ProjectRoot 'src\main.js'
$launcher = Join-Path $ProjectRoot 'src\launcher.js'
$runner = Join-Path $ProjectRoot 'scripts\run-bridge.ps1'
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw '请选择完整的肥鱼项目目录。' }
function Hash-Bytes([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
}
$projectId = (Hash-Bytes ([Text.Encoding]::UTF8.GetBytes($ProjectRoot.ToLowerInvariant()))).Substring(0,20)
$userRoot = Join-Path $env:LOCALAPPDATA ('FeiyuBot\projects\' + $projectId)
New-Item -ItemType Directory -Path $userRoot -Force | Out-Null
$statePath = Join-Path $userRoot 'session.json'
$all = @()
$state = $null
function Read-Processes { $script:all = @(Get-CimInstance Win32_Process) }
function Identity($Process) {
    return @{pid=[int]$Process.ProcessId;created=$Process.CreationDate.ToUniversalTime().Ticks.ToString();path=[string]$Process.ExecutablePath}
}
function Match-Identity($Receipt) {
    return @($script:all | Where-Object {
        $_.ProcessId -eq $Receipt.pid -and $_.ExecutablePath -and $_.ExecutablePath -eq $Receipt.path -and
        $_.CreationDate.ToUniversalTime().Ticks.ToString() -eq $Receipt.created
    }) | Select-Object -First 1
}
function Save-State {
    $temporary = $statePath + '.' + $PID + '.tmp'
    $script:state | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $statePath -Force
}
function Log([string]$Message) {
    $file = Join-Path $userRoot 'desktop-control.log'
    if ((Test-Path -LiteralPath $file) -and (Get-Item -LiteralPath $file).Length -gt 512KB) { [IO.File]::WriteAllText($file,'') }
    Add-Content -LiteralPath $file -Encoding UTF8 -Value ([DateTimeOffset]::UtcNow.ToString('o') + ' ' + $Message)
}
function Command-Contains($Process,[string]$Path) {
    return $Process.CommandLine -and $Process.CommandLine -match ('(?i)(?:^|[\s"])' + [regex]::Escape($Path) + '(?:[\s"]|$)')
}
function Bot-Processes { return @($script:all | Where-Object { $_.Name -eq 'node.exe' -and (Command-Contains $_ $entry) }) }
function Supervisors { return @($script:all | Where-Object { $_.Name -in @('powershell.exe','pwsh.exe') -and (Command-Contains $_ $runner) }) }
function Bundles {
    $root = Join-Path $ProjectRoot '.local\napcat\OneKey'
    if (-not (Test-Path -LiteralPath $root)) { return @() }
    return @(Get-ChildItem -LiteralPath $root -Directory -Filter 'NapCat.*.Shell' | Where-Object {
        $base = $_.FullName
        @('QQ.exe','NapCatWinBootMain.exe','NapCatWinBootHook.dll','loadNapCat.js','napcat.mjs','qqnt.json' | Where-Object { -not (Test-Path -LiteralPath (Join-Path $base $_) -PathType Leaf) }).Count -eq 0
    } | Sort-Object LastWriteTime -Descending)
}
$bundles = @(Bundles)
function Dedicated-Processes {
    $paths = @($bundles | ForEach-Object { Join-Path $_.FullName 'QQ.exe'; Join-Path $_.FullName 'NapCatWinBootMain.exe' })
    return @($script:all | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -in $paths })
}
function Owned-Path([string]$Path) {
    if (-not $Path) { return $false }
    $fixed = @((Get-Command node -ErrorAction SilentlyContinue).Source,
        (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'),
        (Join-Path $ProjectRoot '.local\video-runtime\Scripts\python.exe'),
        (Join-Path $ProjectRoot 'node_modules\ffmpeg-static\ffmpeg.exe'))
    if ($Path -in $fixed) { return $true }
    # Only used after a verified project root/parent is recorded. Python's launcher
    # can select a separate interpreter; model proxy uses a user-installed core.
    if ([IO.Path]::GetFileName($Path).ToLowerInvariant() -in @('py.exe','python.exe','pythonw.exe','ffmpeg.exe','flclashcore.exe')) { return $true }
    foreach ($bundle in $bundles) { if ($Path.StartsWith($bundle.FullName + '\',[StringComparison]::OrdinalIgnoreCase)) { return $true } }
    return $false
}
function Add-Owned($Process,[string]$Kind) {
    if (-not $Process.ExecutablePath -or -not (Owned-Path $Process.ExecutablePath)) { throw ('无法核实进程归属：' + $Kind) }
    $receipt = Identity $Process
    $receipt.kind = $Kind
    if (-not @($script:state.processes | Where-Object { $_.pid -eq $receipt.pid -and $_.created -eq $receipt.created }).Count) {
        $script:state.processes = @($script:state.processes) + @($receipt)
    }
}
function Track-Children {
    if (-not $script:state) { return }
    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($receipt in @($script:state.processes)) {
            $parent = Match-Identity $receipt
            if (-not $parent) { continue }
            foreach ($child in @($script:all | Where-Object { $_.ParentProcessId -eq $parent.ProcessId -and $_.CreationDate -ge $parent.CreationDate })) {
                if (-not (Owned-Path $child.ExecutablePath)) { continue }
                if (@($script:state.processes | Where-Object { $_.pid -eq $child.ProcessId -and $_.created -eq $child.CreationDate.ToUniversalTime().Ticks.ToString() }).Count) { continue }
                $kind = if (Command-Contains $child $entry) { 'bot' } elseif ($receipt.kind -in @('qq','napcat')) { 'qq' } else { 'helper' }
                Add-Owned $child $kind
                $changed = $true
            }
        }
    }
}
function Ensure-Session {
    $owner = @($script:all | Where-Object { $_.ProcessId -eq $OwnerPid }) | Select-Object -First 1
    if (-not $owner -or -not $owner.ExecutablePath -or [IO.Path]::GetFileName($owner.ExecutablePath) -ne 'Feiyu.exe') { throw '桌面进程身份无法核实。' }
    if ($script:state -and (Match-Identity $script:state.owner) -and $script:state.owner.pid -ne $OwnerPid) { throw '已有另一个桌面窗口管理此项目。' }
    if (-not $script:state) { $script:state = @{version=1;owner=(Identity $owner);processes=@();pipe='';token='';managed=$true} }
    else { $script:state.owner = Identity $owner; $script:state.managed = $true }
}
function Port([string]$Name,[int]$Default) {
    $value = [Environment]::GetEnvironmentVariable($Name)
    $file = Join-Path $ProjectRoot '.env'
    if (-not $value -and (Test-Path -LiteralPath $file)) {
        foreach ($line in [IO.File]::ReadLines($file)) {
            if ($line -match ('^\s*'+[regex]::Escape($Name)+'\s*=\s*(.*?)\s*$')) { $value=$Matches[1].Trim().Trim('"').Trim("'") }
        }
    }
    if (-not $value) { return $Default }
    $number=0
    if (-not [int]::TryParse($value,[ref]$number) -or $number -lt 1 -or $number -gt 65535) { throw ('端口配置无效：'+$Name) }
    return $number
}
$webPort = Port 'QQBOT_WEB_PORT' 3000
$onebotPort = Port 'QQBOT_ONEBOT_PORT' 16700
function Revision {
    $receipt = ''
    $sourceRoot = Join-Path $ProjectRoot 'src'
    [string[]]$names = @(Get-ChildItem -LiteralPath $sourceRoot -File | Where-Object { $_.Name.EndsWith('.js',[StringComparison]::Ordinal) } | ForEach-Object { $_.Name })
    # Framework/ICU culture sorting differs between Windows PS5.1 and PS7,
    # particularly commands.js/command-store.js and llm.js/llm-settings-store.js.
    # Node's Array.sort() uses ordinal UTF-16 ordering, independent of culture.
    [Array]::Sort($names,[StringComparer]::Ordinal)
    foreach ($name in $names) {
        $receipt += $name + ':' + (Hash-Bytes ([IO.File]::ReadAllBytes((Join-Path $sourceRoot $name)))) + "`n"
    }
    return Hash-Bytes ([Text.Encoding]::UTF8.GetBytes($receipt))
}
function Health {
    $path = Join-Path $ProjectRoot '.local\bot-health.json'
    if (-not (Test-Path -LiteralPath $path) -or (Get-Item -LiteralPath $path).Length -gt 128KB) { return $null }
    try {
        $health = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
        $worker = @(Bot-Processes | Where-Object { $_.ProcessId -eq $health.pid }) | Select-Object -First 1
        $age=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-[long]$health.updatedAt
        if ($health.version -eq 1 -and $worker -and $age -ge -2000 -and $age -le 20000 -and [long]$health.startedAt -ge ([DateTimeOffset]$worker.CreationDate).ToUnixTimeMilliseconds()-2000) { return $health }
    } catch {}
    return $null
}
function Local-Post([int]$Port,[string]$Route,$Body,[string]$Credential='') {
    Add-Type -AssemblyName System.Net.Http
    $handler=New-Object Net.Http.HttpClientHandler
    $handler.UseProxy=$false;$handler.AllowAutoRedirect=$false
    $client=New-Object Net.Http.HttpClient($handler)
    $client.Timeout=[TimeSpan]::FromMilliseconds(1800);$client.MaxResponseContentBufferSize=65536
    try {
        if($Credential){$client.DefaultRequestHeaders.Authorization=New-Object Net.Http.Headers.AuthenticationHeaderValue('Bearer',$Credential)}
        $bodyText=$Body | ConvertTo-Json -Compress
        $content=New-Object Net.Http.StringContent($bodyText,[Text.Encoding]::UTF8,'application/json')
        try {
            $response=$client.PostAsync(('http://127.0.0.1:'+$Port+'/api/'+$Route),$content).GetAwaiter().GetResult()
            try {if(-not $response.IsSuccessStatusCode){throw 'Local API unavailable'};return ($response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json)}finally{$response.Dispose()}
        } finally {$content.Dispose()}
    } finally {$client.Dispose();$handler.Dispose()}
}
function Login-Status([switch]$Refresh) {
    $work=Join-Path $ProjectRoot '.local\napcat\bot-workdir'
    $qr=Join-Path $work 'cache\qrcode.png'
    $result=@{available=$false;phase='starting';isLogin=$false;qrFresh=$false;qrPath='';qrAgeSeconds=0;error='';sharedProfile=$false;webOrigin=''}
    if(Test-Path -LiteralPath $qr -PathType Leaf){
        $file=Get-Item -LiteralPath $qr
        $age=([DateTime]::UtcNow-$file.LastWriteTimeUtc).TotalSeconds
        if($file.Length -gt 0 -and $file.Length -lt 2MB -and $age -ge -2){$result.qrPath=$qr;$result.qrAgeSeconds=[int]$age;$result.qrFresh=$age -lt 115}
    }
    $own=@(Dedicated-Processes)
    $other=@($script:all | Where-Object {$_.Name -eq 'QQ.exe' -and $_.ExecutablePath -and $_.ExecutablePath -notin $own.ExecutablePath})
    $ownProfiles=@($own | ForEach-Object {if($_.CommandLine -match '--user-data-dir="([^"]+)"'){$Matches[1]}})
    foreach($item in $other){if($item.CommandLine -match '--user-data-dir="([^"]+)"' -and $Matches[1] -in $ownProfiles){$result.sharedProfile=$true}}
    $config=Join-Path $work 'config\webui.json'
    if(-not (Test-Path -LiteralPath $config)){return $result}
    try {
        if((Get-Item -LiteralPath $config).Length -gt 64KB){throw 'Invalid local config'}
        $settings=Get-Content -LiteralPath $config -Raw -Encoding UTF8 | ConvertFrom-Json
        $portNumber=0
        if(-not [int]::TryParse([string]$settings.port,[ref]$portNumber) -or $portNumber -lt 1 -or $portNumber -gt 65535 -or $settings.host -notin @('127.0.0.1','localhost','::1') -or -not $settings.token){throw 'Invalid loopback config'}
        $listener=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {$_.LocalPort -ge $portNumber -and $_.LocalPort -le [Math]::Min(65535,$portNumber+100) -and $_.OwningProcess -in $own.ProcessId} | Sort-Object LocalPort)
        if(-not $listener.Count){return $result}
        $portNumber=[int]$listener[0].LocalPort
        $result.webOrigin='http://127.0.0.1:'+$portNumber
        # Authenticate only to a listener owned by this project's exact dedicated
        # QQ executable. Never expose credentials or QR URLs in status/logs.
        if($settings.enable2FA){$result.error='webui-2fa';return $result}
        $fingerprint=Hash-Bytes ([Text.Encoding]::UTF8.GetBytes([string]$settings.token))
        $cache=Join-Path $userRoot 'napcat-webui-session.json'
        $saved=$null;if(Test-Path -LiteralPath $cache){try{$saved=Get-Content -LiteralPath $cache -Raw | ConvertFrom-Json}catch{}}
        $credential=''
        if($saved -and $saved.fingerprint -eq $fingerprint -and $saved.port -eq $portNumber -and $saved.listener -in $listener.OwningProcess -and ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()-[long]$saved.at) -lt 3000){$credential=$saved.credential}
        for($attempt=0;$attempt -lt 2;$attempt++){
            if(-not $credential){
                $hash=Hash-Bytes ([Text.Encoding]::UTF8.GetBytes(([string]$settings.token)+'.napcat'))
                $auth=Local-Post $portNumber 'auth/login' @{hash=$hash}
                $credential=[string]$auth.data.Credential
                if(-not $credential){$result.error='webui-auth';return $result}
                $temp=$cache+'.tmp'
                @{fingerprint=$fingerprint;port=$portNumber;listener=$listener[0].OwningProcess;credential=$credential;at=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()} | ConvertTo-Json -Compress | Set-Content -LiteralPath $temp -Encoding UTF8
                Move-Item -LiteralPath $temp -Destination $cache -Force
            }
            $reply=Local-Post $portNumber 'QQLogin/CheckLoginStatus' @{} $credential
            if($reply.code -eq 0 -and $reply.data){break};$credential=''
        }
        if($reply.code -ne 0 -or -not $reply.data){$result.error='webui-status';return $result}
        $data=$reply.data
        $result.available=$true;$result.isLogin=$data.isLogin -eq $true
        $phases=@('waiting_qrcode','generating_qrcode','qrcode_scanned','initializing','reconnecting','ready','offline')
        $result.phase=if($data.loginPhase -in $phases){[string]$data.loginPhase}else{'initializing'}
        if($data.loginError){$result.error='qq-login-error'}
        if($Refresh -and -not $result.isLogin){
            $refreshed=Local-Post $portNumber 'QQLogin/RefreshQRcode' @{} $credential
            if($refreshed.code -ne 0){$result.error='qr-refresh'}else{$result.phase='generating_qrcode';$result.qrFresh=$false}
        }
    } catch {$result.error='webui-unavailable'}
    return $result
}
function Start-Preflight {
    $required=@('src\main.js','src\launcher.js','node_modules\ws\package.json')
    $fixtureMode=$ProjectRoot -match '\\desktop-acceptance-[a-f0-9]{32}$' -and (Test-Path -LiteralPath (Join-Path $ProjectRoot '.local\desktop-fixture.marker'))
    if(-not $fixtureMode){$required+=@('node_modules\sharp\package.json','node_modules\undici\package.json','node_modules\ffmpeg-static\package.json')}
    foreach($file in $required){if(-not(Test-Path -LiteralPath (Join-Path $ProjectRoot $file) -PathType Leaf)){throw ('缺少启动依赖：'+$file)}}
    $node=(Get-Command node -ErrorAction Stop).Source
    $version=& $node --version
    if($version -notmatch '^v(\d+)\.(\d+)' -or [int]$Matches[1] -lt 20 -or ([int]$Matches[1] -eq 20 -and [int]$Matches[2] -lt 9)){throw '需要 Node.js 20.9 或更高版本。'}
    if(-not $bundles.Count){throw '缺少完整的专用 NapCat/QQ 安装，请按依赖清单安装。'}
    if(-not $fixtureMode){
        & $node --input-type=module -e "import('sharp').then(s=>process.exit(s.default.versions.vips?0:1)).catch(()=>process.exit(1))"
        if($LASTEXITCODE){throw '图片原生组件无法加载，请修复本机 sharp 依赖后启动。'}
        $token=[Environment]::GetEnvironmentVariable('ONEBOT_ACCESS_TOKEN');$pathValue=[Environment]::GetEnvironmentVariable('QQBOT_ONEBOT_PATH')
        $environment=Join-Path $ProjectRoot '.env'
        if(Test-Path -LiteralPath $environment){foreach($line in [IO.File]::ReadLines($environment)){
            if(-not $token -and $line -match '^\s*ONEBOT_ACCESS_TOKEN\s*=\s*(.*?)\s*$'){$token=$Matches[1].Trim().Trim('"').Trim("'")}
            if(-not $pathValue -and $line -match '^\s*QQBOT_ONEBOT_PATH\s*=\s*(.*?)\s*$'){$pathValue=$Matches[1].Trim().Trim('"').Trim("'")}
        }}
        if(-not $pathValue){$pathValue='/onebot/v11/ws'}
        if(-not $token -or $token -notmatch '^[A-Za-z0-9._~-]{32,512}$'){throw '缺少有效的本机 OneBot 接入密钥。'}
        $expected='ws://127.0.0.1:'+$onebotPort+$pathValue;$matched=$false
        $configs=Join-Path $ProjectRoot '.local\napcat\bot-workdir\config'
        foreach($file in @(Get-ChildItem -LiteralPath $configs -Filter 'onebot11*.json' -File -ErrorAction SilentlyContinue)){
            try{$config=Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json;foreach($client in $config.network.websocketClients){if($client.enable -eq $true -and $client.url -eq $expected -and $client.token -ceq $token){$matched=$true}}}catch{}
        }
        if(-not $matched){throw '专用 NapCat 的反向 WebSocket 地址或密钥尚未与本机 OneBot 匹配，请检查本机配置。'}
    }
}
function Advance-Startup {
    if(-not $script:state.startRequested){return}
    Read-Processes;Track-Children
    if(-not @(Bot-Processes).Count){Start-Bot;Read-Processes;Track-Children}
    $health=Health
    if($health -and $health.runtimeRevision -ne (Revision) -and -not $script:state.codeRestarted){
        $script:state.codeRestarted=$true;Save-State;Stop-Kinds @('bot','launcher','helper','supervisor');Start-Bot;Read-Processes
    }
    if(-not @(Dedicated-Processes).Count){Start-QQ;Read-Processes;Track-Children}
    $login=Login-Status
    $age=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()-[long]$script:state.startAt
    if(-not $login.isLogin -and $login.available -and $login.phase -eq 'waiting_qrcode' -and $login.qrAgeSeconds -gt 100 -and ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()-[long]$script:state.lastQrRefresh) -gt 90){
        $script:state.lastQrRefresh=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds();$null=Login-Status -Refresh
    }
    # Repair only an owned, unresponsive shell once. Waiting for phone approval
    # is not a crash and never triggers a QQ restart.
    if($age -gt 50 -and -not $login.available -and -not $login.qrFresh -and -not $script:state.shellRepaired -and -not $login.error){
        $script:state.shellRepaired=$true;Save-State;Stop-Kinds @('qq','napcat');Start-QQ
    }
    Save-State
}
function Safe-Stop($Receipt) {
    # Recheck PID + creation timestamp + dedicated executable immediately before every stop.
    Read-Processes
    $current = Match-Identity $Receipt
    if (-not $current) { return }
    if (-not (Owned-Path $current.ExecutablePath)) { throw ('无法核实待停止的组件：'+$Receipt.kind) }
    Stop-Process -Id $current.ProcessId -ErrorAction Stop
}
function Graceful-Bot {
    if (-not $script:state.pipe -or -not $script:state.token) { return }
    $pipe = New-Object IO.Pipes.NamedPipeClientStream('.', $script:state.pipe, [IO.Pipes.PipeDirection]::InOut)
    try {
        $pipe.Connect(1200)
        $writer = New-Object IO.StreamWriter($pipe, (New-Object Text.UTF8Encoding($false)), 1024, $true)
        $writer.WriteLine((@{action='shutdown';token=$script:state.token} | ConvertTo-Json -Compress)); $writer.Flush(); $writer.Dispose()
    } catch { Log 'Graceful shutdown pipe unavailable; bounded owned-process fallback may be needed.' }
    finally { $pipe.Dispose() }
}
function Stop-Kinds([string[]]$Kinds) {
    Read-Processes; Track-Children; Save-State
    if ('bot' -in $Kinds) {
        # Legacy supervisors could respawn Node, so stop their recorded identities first.
        foreach ($receipt in @($script:state.processes | Where-Object { $_.kind -eq 'supervisor' })) { Safe-Stop $receipt }
        Graceful-Bot
        $until=[DateTime]::UtcNow.AddSeconds(15)
        do {
            Read-Processes; Track-Children; Save-State
            $active=@($script:state.processes | Where-Object { $_.kind -eq 'bot' -and (Match-Identity $_) })
            if (-not $active.Count) { break }
            Start-Sleep -Milliseconds 250
        } while ([DateTime]::UtcNow -lt $until)
    }
    # Give dedicated QQ its normal window-close path before a bounded force fallback.
    foreach ($receipt in @($script:state.processes | Where-Object { $_.kind -in $Kinds -and $_.kind -in @('qq','napcat') })) {
        Read-Processes
        if (Match-Identity $receipt) { try { [void](Get-Process -Id $receipt.pid).CloseMainWindow() } catch {} }
    }
    if ('qq' -in $Kinds) { Start-Sleep -Milliseconds 1200 }
    Read-Processes; Track-Children; Save-State
    foreach ($receipt in @($script:state.processes | Where-Object { $_.kind -in $Kinds } | Sort-Object @{Expression={if ($_.kind -eq 'bot') {0} elseif ($_.kind -eq 'helper') {1} else {2}}})) { Safe-Stop $receipt }
    Start-Sleep -Milliseconds 400
    Read-Processes; Track-Children; Save-State
    $left=@($script:state.processes | Where-Object { $_.kind -in $Kinds -and (Match-Identity $_) })
    if ($left.Count) { throw ('停止失败，仍在运行：'+(($left | ForEach-Object { $_.kind+' PID '+$_.pid }) -join '、')) }
}
function New-Random([int]$Count) {
    $bytes=New-Object byte[] $Count
    $rng=[Security.Cryptography.RandomNumberGenerator]::Create()
    try {$rng.GetBytes($bytes)} finally {$rng.Dispose()}
    return ([BitConverter]::ToString($bytes)).Replace('-','').ToLowerInvariant()
}
function Start-Bot {
    if (@(Bot-Processes).Count -or @(Supervisors).Count) { return }
    $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in @($webPort,$onebotPort) })
    if ($listeners.Count) { throw '管理页或 OneBot 端口被其他进程占用；请先处理占用，程序不会终止它。' }
    $node=(Get-Command node -ErrorAction Stop).Source
    if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'node_modules\ws\package.json'))) { throw '缺少 Node 依赖；请先在项目目录执行 npm ci。' }
    $script:state.pipe='FeiyuBot-'+(New-Random 24);$script:state.token=New-Random 32
    $oldPipe=$env:FEIYU_DESKTOP_PIPE;$oldToken=$env:FEIYU_DESKTOP_TOKEN
    try {
        $env:FEIYU_DESKTOP_PIPE=$script:state.pipe;$env:FEIYU_DESKTOP_TOKEN=$script:state.token
        $child=Start-Process -FilePath $node -ArgumentList ('"'+$launcher+'"') -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $userRoot 'bot.stdout.log') -RedirectStandardError (Join-Path $userRoot 'bot.stderr.log')
        Read-Processes
        $item=@($script:all | Where-Object {$_.ProcessId -eq $child.Id}) | Select-Object -First 1
        if (-not $item) { throw 'Node 在启动时退出，请查看本地日志。' }
        Add-Owned $item 'launcher';Track-Children;Save-State;Log 'Project Node launcher created and ownership recorded.'
    } finally {$env:FEIYU_DESKTOP_PIPE=$oldPipe;$env:FEIYU_DESKTOP_TOKEN=$oldToken}
}
function Show-Login {
    $login=Login-Status
    if($login.available -or $login.qrPath){return}
    if (-not ('FeiyuWindows' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FeiyuWindows {
 public delegate bool Callback(IntPtr h, IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr p);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
 [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
}
'@
    }
    $script:shown=0
    $qqPids=@(Dedicated-Processes | Where-Object {$_.Name -eq 'QQ.exe'} | ForEach-Object {[int]$_.ProcessId})
    $callback=[FeiyuWindows+Callback]{param($window,$unused)
        [uint32]$windowPid=0
        [void][FeiyuWindows]::GetWindowThreadProcessId($window,[ref]$windowPid)
        if ([int]$windowPid -in $qqPids -and [FeiyuWindows]::GetWindowTextLength($window) -gt 0) {
            [void][FeiyuWindows]::ShowWindowAsync($window,9);[void][FeiyuWindows]::SetForegroundWindow($window);$script:shown++
        }
        return $true
    }
    [void][FeiyuWindows]::EnumWindows($callback,[IntPtr]::Zero)
    if (-not $script:shown) { throw '专用 QQ 没有可恢复的登录窗口。请点击“重启专用 QQ”，以可见窗口重新启动；不会退出其他 QQ。' }
}
function Start-QQ {
    if (@(Dedicated-Processes).Count) { return }
    $bundle=$bundles | Select-Object -First 1
    if (-not $bundle) { throw '缺少完整的专用 NapCat/QQ 安装，请按依赖清单安装。' }
    $variables=@{NAPCAT_PATCH_PACKAGE='qqnt.json';NAPCAT_LOAD_PATH='loadNapCat.js';NAPCAT_INJECT_PATH='NapCatWinBootHook.dll';NAPCAT_LAUNCHER_PATH='NapCatWinBootMain.exe';NAPCAT_MAIN_PATH='napcat.mjs'}
    $before=@{}
    try {
        foreach ($name in $variables.Keys) {$before[$name]=[Environment]::GetEnvironmentVariable($name,'Process');[Environment]::SetEnvironmentVariable($name,(Join-Path $bundle.FullName $variables[$name]),'Process')}
        $before['NAPCAT_WORKDIR']=$env:NAPCAT_WORKDIR;$env:NAPCAT_WORKDIR=Join-Path $ProjectRoot '.local\napcat\bot-workdir'
        # Visible window explicitly required by the user's interactive login request.
        $child=Start-Process -FilePath (Join-Path $bundle.FullName 'NapCatWinBootMain.exe') -ArgumentList ('"'+(Join-Path $bundle.FullName 'QQ.exe')+'" "'+(Join-Path $bundle.FullName 'NapCatWinBootHook.dll')+'"') -WorkingDirectory $bundle.FullName -WindowStyle Normal -PassThru
        Start-Sleep -Milliseconds 350
        Read-Processes
        $item=@($script:all | Where-Object {$_.ProcessId -eq $child.Id}) | Select-Object -First 1
        if ($item) {Add-Owned $item 'napcat'}
        # Boot may detach/exit quickly. Claim only the exact dedicated executable paths.
        foreach ($item in @(Dedicated-Processes)) {Add-Owned $item $(if($item.Name -eq 'QQ.exe'){'qq'}else{'napcat'})}
        Track-Children;Save-State;Log 'Dedicated QQ/NapCat launched with visible login/bootstrap window.'
    } finally {foreach($name in $before.Keys){[Environment]::SetEnvironmentVariable($name,$before[$name],'Process')}}
}
function Disable-LegacyStartup {
    # Only exact project-runner actions; never global QQ tasks or browser startup.
    foreach($task in @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { @($_.Actions | Where-Object {$_.Arguments -and $_.Arguments.Contains($runner)}).Count })) {
        $actions=@($task.Actions)
        if($actions.Count -ne 1){throw '旧计划任务包含其他动作，无法安全接管；请手动移除本项目开机动作。'}
        Disable-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction Stop | Out-Null
    }
    $startup=[Environment]::GetFolderPath('Startup')
    $shell=New-Object -ComObject WScript.Shell
    foreach($file in @(Get-ChildItem -LiteralPath $startup -Filter '*.lnk' -File)) {
        $shortcut=$shell.CreateShortcut($file.FullName)
        if($shortcut.Arguments -and $shortcut.Arguments.Contains($runner)) {
            $backup=Join-Path $userRoot ($file.BaseName+'.'+[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+'.disabled.lnk')
            Move-Item -LiteralPath $file.FullName -Destination $backup
        }
    }
}
function Snapshot {
    Read-Processes
    if($script:state){Track-Children;Save-State}
    $workers=@(Bot-Processes);$supervisors=@(Supervisors);$dedicated=@(Dedicated-Processes)
    $health=Health;$revision=Revision
    $owned=@();if($script:state){$owned=@($script:state.processes | Where-Object {Match-Identity $_})}
    $external=@(@($workers)+@($supervisors)+@($dedicated) | Where-Object {$item=$_;-not @($owned | Where-Object {$_.pid -eq $item.ProcessId}).Count})
    $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {$_.LocalPort -in @($webPort,$onebotPort)})
    $panelOwned=@($listeners | Where-Object {$_.LocalPort -eq $webPort -and $_.OwningProcess -in $workers.ProcessId}).Count -gt 0
    $otherPorts=@($listeners | Where-Object {$_.OwningProcess -notin $workers.ProcessId} | ForEach-Object {$_.LocalPort} | Sort-Object -Unique)
    $current=$health -and $health.runtimeRevision -eq $revision
    $login=Login-Status
    $ready=$current -and $health.coreReady -eq $true -and $external.Count -eq 0 -and $script:state.managed -eq $true -and $login.available -and $login.isLogin
    $phase=if($ready){'ready'}elseif(-not $workers.Count){'starting-node'}elseif(-not $panelOwned -or -not $health){'initializing-node'}elseif(-not $dedicated.Count){'starting-napcat'}elseif($login.phase -eq 'qrcode_scanned'){'waiting-phone-confirmation'}elseif($login.phase -eq 'initializing'){'initializing-qq'}elseif($login.isLogin -and -not $health.onebot.connected){'waiting-onebot'}elseif($login.qrPath -and -not $login.qrFresh){'refreshing-qr'}elseif($login.phase -eq 'waiting_qrcode'){'waiting-qr'}elseif($login.error){'login-error'}else{'starting-napcat'}
    $rows=@(
        @{name='桌面管理权';status=$(if($external.Count){'发现旧版/外部项目服务，尚未接管'}elseif($script:state.managed){'本窗口管理；关窗将停止全部已接管服务'}else{'尚未启动'});next=$(if($external.Count){'点击“接管旧服务”并确认退出语义'}else{'点击“启动服务”'})},
        @{name='Node 代码版本';status=$(if(-not $workers.Count){'未运行'}elseif(-not $health){'旧进程/无新鲜健康快照'}elseif(-not $current){'运行版本落后于磁盘源码'}else{'源码版本一致 '+$revision.Substring(0,10)});next=$(if($workers.Count -and -not $current){'接管后点击“重启 bot”加载新代码'}else{'无需操作'})},
        @{name='内置管理前端 / 本机 API';status=$(if($panelOwned){'本项目 API 正在监听 '+$webPort}else{'API 尚未就绪'});next=$(if($panelOwned){'切换到“管理面板”登录'}else{'启动 Node；查看启动日志'})},
        @{name='专用 QQ / NapCat';status=$(if($health -and $health.onebot.connected){'授权 OneBot 会话已连接；收发未实测'}elseif($dedicated.Count){'进程存在但未连接，不能视为登录成功'}else{'未启动'});next=$(if($health -and $health.onebot.connected){'无需登录操作'}elseif($dedicated.Count){'显示登录窗口；无窗口时重启专用 QQ'}else{'启动服务后在可见窗口登录'})}
    )
    $rows+=@{name='QQ 登录流程';status=$phase;next=$(if($phase -eq 'waiting-qr'){'打开“QQ 登录”，手机 QQ 扫码并确认；程序自动继续'}elseif($phase -eq 'waiting-onebot'){'QQ已登录；正在等待 OneBot 实际握手，无需再次启动'}elseif($phase -eq 'ready'){'QQ与OneBot均已核实'}elseif($login.error){'查看“QQ 登录”中的具体下一步'}else{'程序会持续检查登录和连接，无需再次点启动'})}
    if($login.sharedProfile){$rows+=@{name='QQ 资料目录';status='检测到与其他 QQ 共用资料目录';next='本轮不移动或清理既有登录资料；扫码入口使用专用 NapCat 工作目录'}}
    if($health){foreach($component in $health.components){if($component.id -notin @('management','onebot')){$rows+=@{name=$component.label;status=$component.state;next=$(if($component.state -eq 'missing-dependency'){'补齐本地配置/依赖'}elseif($component.state -eq 'failed'){'查看本机日志'}else{'外部效果未由桌面端探测'})}}}}
    return @{ok=$true;projectRoot=$ProjectRoot;userRoot=$userRoot;managed=[bool]$script:state.managed;needsTakeover=($external.Count -gt 0);externalCount=$external.Count;ownedCount=$owned.Count;ownedProcesses=$owned;workers=@($workers | ForEach-Object {@{pid=$_.ProcessId;created=$_.CreationDate.ToUniversalTime().ToString('o')}});panelReady=$panelOwned;panelUrl=('http://127.0.0.1:'+$webPort+'/');otherListenerPorts=$otherPorts;coreReady=[bool]$ready;freshHealth=[bool]$health;runtimeCurrent=[bool]$current;sourceRevision=$revision;rows=$rows;login=$login;startup=@{requested=[bool]$script:state.startRequested;phase=$phase;startedAt=$script:state.startAt};stopped=($owned.Count -eq 0);portsReleased=($listeners.Count -eq 0)}
}

$mutex=New-Object Threading.Mutex($false,('Local\FeiyuBot-Control-'+$projectId))
$locked=$false
try {
    try{$locked=$mutex.WaitOne(15000)}catch [Threading.AbandonedMutexException]{$locked=$true}
    if(-not $locked){throw '另一项启动/停止操作仍在进行，请稍候。'}
    Read-Processes
    if(Test-Path -LiteralPath $statePath){$loaded=Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json;$script:state=@{};foreach($property in $loaded.PSObject.Properties){$script:state[$property.Name]=$property.Value};$script:state.processes=@($loaded.processes)}
    if($Action -notin @('Status','Preflight')){
        Ensure-Session
        $status=Snapshot
        if($status.needsTakeover -and $Action -notin @('Takeover','Stop')){throw '发现未接管的项目服务，请先明确接管；尚未修改任何服务。'}
    }
    switch($Action){
        'Preflight' {Start-Preflight}
        'Takeover' {
            Disable-LegacyStartup
            foreach($item in @(Bot-Processes)){
                Add-Owned $item 'bot'
                $parent=@($script:all | Where-Object {$_.ProcessId -eq $item.ParentProcessId -and $_.Name -eq 'node.exe'}) | Select-Object -First 1
                if($parent -and ((Command-Contains $parent $launcher) -or $parent.CommandLine -match '(?i)\s+"?src[/\\]launcher\.js"?\s*$')){Add-Owned $parent 'launcher'}
            }
            foreach($item in @(Supervisors)){Add-Owned $item 'supervisor'
                # The legacy launcher may use relative src/launcher.js; require recorded supervisor ancestry.
                $parent=@($script:all | Where-Object {$_.ProcessId -eq $item.ParentProcessId}) | Select-Object -First 1
                foreach($child in @($script:all | Where-Object {$_.ParentProcessId -eq $item.ProcessId -and $_.Name -eq 'node.exe'})){Add-Owned $child 'launcher'}
            }
            foreach($item in @(Dedicated-Processes)){Add-Owned $item $(if($item.Name -eq 'QQ.exe'){'qq'}else{'napcat'})}
            Track-Children;Save-State;Log 'Explicit takeover recorded dedicated process identities and disabled exact legacy startup actions.'
        }
        'Start' {Start-Preflight;$script:state.startRequested=$true;$script:state.startAt=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds();$script:state.codeRestarted=$false;$script:state.shellRepaired=$false;Save-State;Advance-Startup}
        'Advance' {Advance-Startup}
        'RefreshLogin' {$null=Login-Status -Refresh}
        'LoginWeb' {
            # Only this explicit desktop action returns a short-lived WebUI
            # credential over the private controller pipe. Status stays secret-free.
            $login=Login-Status
            $credential=''
            if($login.available -and $login.webOrigin){
                $cache=Join-Path $userRoot 'napcat-webui-session.json'
                if(Test-Path -LiteralPath $cache){$saved=Get-Content -LiteralPath $cache -Raw -Encoding UTF8 | ConvertFrom-Json;$credential=[string]$saved.credential}
            }
            @{ok=$true;origin=$login.webOrigin;credential=$credential} | ConvertTo-Json -Compress
            exit 0
        }
        'ShowLogin' {Show-Login}
        'RestartBot' {Stop-Kinds @('bot','launcher','helper','supervisor');Start-Bot}
        'RestartQQ' {Stop-Kinds @('qq','napcat');Start-QQ}
        'Stop' {
            Save-State;Stop-Kinds @('bot','launcher','helper','supervisor');Stop-Kinds @('qq','napcat')
            $final=Snapshot
            if(-not $final.stopped -or -not $final.portsReleased){throw '退出未完成：仍有已管理进程或管理/OneBot端口监听。窗口将保留，请检查状态后重试。'}
            $script:state.managed=$false;$script:state.startRequested=$false;Save-State;Log 'All recorded services stopped; management and OneBot listener ports released.'
        }
    }
    Snapshot | ConvertTo-Json -Depth 12 -Compress
} catch {
    $message=$_.Exception.Message
    Log ('Action '+$Action+' failed; no credentials logged.')
    @{ok=$false;error=$message} | ConvertTo-Json -Compress
    exit 1
} finally {if($locked){$mutex.ReleaseMutex()};$mutex.Dispose()}
