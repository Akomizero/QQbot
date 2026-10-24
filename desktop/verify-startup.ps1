param([string]$Exe=(Join-Path $PSScriptRoot 'dist\0.2.2\Feiyu.exe'))
$ErrorActionPreference='Stop'
$root=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$fixture=Join-Path $root ('.local\desktop-acceptance-'+[Guid]::NewGuid().ToString('N'))
$work=Join-Path $fixture '.local\napcat\bot-workdir'
$bundle=Join-Path $fixture '.local\napcat\OneKey\NapCat.Fixture.Shell'
New-Item -ItemType Directory -Path (Join-Path $fixture 'src'),(Join-Path $fixture 'scripts'),(Join-Path $fixture 'node_modules'),(Join-Path $work 'config'),(Join-Path $work 'cache'),$bundle,(Join-Path $fixture '.fixture-build') -Force | Out-Null
$encoding=New-Object Text.UTF8Encoding($false)
function Write-Text([string]$Path,[string]$Text){[IO.File]::WriteAllText($Path,$Text,$encoding)}
function Free-Port{$l=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,0);$l.Start();$p=$l.LocalEndpoint.Port;$l.Stop();return $p}
$web=Free-Port;$ws=Free-Port;$napcat=Free-Port
Write-Text (Join-Path $fixture 'package.json') '{"type":"module"}'
Write-Text (Join-Path $fixture '.env') ("QQBOT_WEB_PORT=$web`nQQBOT_ONEBOT_PORT=$ws`n")
Write-Text (Join-Path $fixture '.local\desktop-fixture.marker') 'feiyu-desktop-isolated-v1'
Write-Text (Join-Path $work 'fixture.marker') 'fake-napcat-only'
Write-Text (Join-Path $work 'fixture-plan.json') ('{"wsPort":'+$ws+'}')
Write-Text (Join-Path $work 'phone-state.json') '{"isLogin":false,"connect":false}'
Write-Text (Join-Path $work 'config\webui.json') ('{"host":"127.0.0.1","port":'+$napcat+',"token":"fixture-only-token"}')
Write-Text (Join-Path $work 'login-preserved.txt') 'fixture-login-state-must-survive-exit'
Add-Type -AssemblyName System.Drawing
$bitmap=New-Object Drawing.Bitmap(180,180);$graphics=[Drawing.Graphics]::FromImage($bitmap);$graphics.Clear([Drawing.Color]::White)
for($x=0;$x -lt 15;$x++){for($y=0;$y -lt 15;$y++){if(($x+$y)%2 -eq 0){$graphics.FillRectangle([Drawing.Brushes]::Black,($x*10+15),($y*10+15),10,10)}}}
$bitmap.Save((Join-Path $work 'cache\qrcode.png'),[Drawing.Imaging.ImageFormat]::Png);$graphics.Dispose();$bitmap.Dispose()
Copy-Item -LiteralPath (Join-Path $root 'node_modules\ws') -Destination (Join-Path $fixture 'node_modules\ws') -Recurse
foreach($file in @('launcher.js','desktop-lifecycle.js','runtime-revision.js','service-health.js')){Copy-Item -LiteralPath (Join-Path $root ('src\'+$file)) -Destination (Join-Path $fixture ('src\'+$file))}
$main=@'
import {createServer} from 'node:http';
import {appendFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {WebSocketServer,WebSocket} from 'ws';
import {startDesktopLifecycle} from './desktop-lifecycle.js';
import {createServiceHealth} from './service-health.js';
const helper=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});helper.unref();
const log=new URL('../.local/api-observed.log',import.meta.url);
const web=createServer((req,res)=>{appendFileSync(log,req.method+' '+req.url+'\n');res.writeHead(200,{'content-type':'application/json'});res.end('{"setupRequired":false,"authenticated":false}');});
const bridge=createServer();const ws=new WebSocketServer({noServer:true});let connection;
bridge.on('upgrade',(req,socket,head)=>{if(req.headers.authorization!=='Bearer fixture-onebot-token'){socket.destroy();return}ws.handleUpgrade(req,socket,head,client=>{connection=client;void health.refresh();client.on('close',()=>{connection=null;void health.refresh()})})});
await new Promise(resolve=>web.listen(WEBPORT,'127.0.0.1',resolve));await new Promise(resolve=>bridge.listen(WSPORT,'127.0.0.1',resolve));
const health=createServiceHealth({getSettings:()=>({}),getOneBotStatus:()=>({connected:connection?.readyState===WebSocket.OPEN}),getManagementListening:()=>web.listening});
for(const id of ['configuration','onebot','management','replyRecovery','memoryMaintenance'])health.component(id,'ready');health.completeStartup();
let lifecycle;lifecycle=await startDesktopLifecycle(async()=>{appendFileSync(log,'graceful-shutdown\n');await health.stop();connection?.terminate();ws.close();bridge.close();web.close();await lifecycle.close()});
'@
Write-Text (Join-Path $fixture 'src\main.js') ($main.Replace('WEBPORT',[string]$web).Replace('WSPORT',[string]$ws))
$build=Join-Path $fixture '.fixture-build'
Write-Text (Join-Path $build 'Stub.csproj') '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup></Project>'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'fixtures\NapCatStub.cs.txt') -Destination (Join-Path $build 'Program.cs')
& dotnet build (Join-Path $build 'Stub.csproj') -c Release -o (Join-Path $build 'out') --nologo | Out-Null
if($LASTEXITCODE){throw '隔离 NapCat stub 构建失败。'}
foreach($file in @('Stub.dll','Stub.runtimeconfig.json','Stub.deps.json')){Copy-Item -LiteralPath (Join-Path $build ('out\'+$file)) -Destination (Join-Path $bundle $file)}
foreach($name in @('QQ.exe','NapCatWinBootMain.exe')){Copy-Item -LiteralPath (Join-Path $build 'out\Stub.exe') -Destination (Join-Path $bundle $name)}
foreach($name in @('NapCatWinBootHook.dll','loadNapCat.js','napcat.mjs','qqnt.json')){Write-Text (Join-Path $bundle $name) 'fixture-only'}
$realBefore=@(Get-CimInstance Win32_Process | Where-Object {($_.Name -eq 'QQ.exe' -and $_.CommandLine -notmatch '--type=') -or ($_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.Contains((Join-Path $root 'src\main.js')))} | ForEach-Object {$_.ProcessId.ToString()+':'+$_.CreationDate.ToUniversalTime().Ticks})
$savedPrefsPath=Join-Path $env:LOCALAPPDATA 'FeiyuBot\desktop.json';$savedPrefs=if(Test-Path -LiteralPath $savedPrefsPath){[IO.File]::ReadAllText($savedPrefsPath)}else{$null}
$identity=([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($fixture.ToLowerInvariant())))).Replace('-','').ToLowerInvariant().Substring(0,20)
$userRoot=Join-Path $env:LOCALAPPDATA ('FeiyuBot\projects\'+$identity)
$records=@();$app=$null
function Wait-Ui([string]$Phase,[bool]$Ready,[int]$Seconds=65){
    $deadline=[DateTime]::UtcNow.AddSeconds($Seconds);$value=$null
    do{try{$value=Get-Content -LiteralPath (Join-Path $userRoot 'desktop-ui-status.json') -Raw | ConvertFrom-Json;if($value.phase -eq $Phase -and $value.ready -eq $Ready){return $value}}catch{};Start-Sleep -Milliseconds 400}while([DateTime]::UtcNow -lt $deadline)
    throw ('隔离 UI 未到达状态 '+$Phase+'，最后状态 '+($value | ConvertTo-Json -Compress))
}
try {
    # Single EXE invocation. No second Start action is issued.
    $app=Start-Process -FilePath $Exe -ArgumentList ('--verify-fixture --project "'+$fixture+'"') -WindowStyle Normal -PassThru
    $waiting=Wait-Ui 'waiting-qr' $false
    $loginDeadline=[DateTime]::UtcNow.AddSeconds(20)
    while(-not $waiting.qrDisplayed -and -not $waiting.napcatPageLoaded -and [DateTime]::UtcNow -lt $loginDeadline){
        Start-Sleep -Milliseconds 400
        try{$waiting=Get-Content -LiteralPath (Join-Path $userRoot 'desktop-ui-status.json') -Raw | ConvertFrom-Json}catch{}
    }
    if(-not $waiting.qrDisplayed -and -not $waiting.napcatPageLoaded){throw '等待扫码时程序未显示本机 NapCat 登录页或备用二维码。'}
    $records+=@{case='single-exe-starts-node-shell-and-displays-local-login-entry';pass=$true;appPid=$app.Id;qrDisplayed=$waiting.qrDisplayed;napcatPageLoaded=$waiting.napcatPageLoaded}
    Write-Text (Join-Path $work 'phone-state.json') '{"isLogin":true,"connect":false}'
    $null=Wait-Ui 'waiting-onebot' $false
    $records+=@{case='qq-login-alone-does-not-claim-ready';pass=$true}
    Write-Text (Join-Path $work 'phone-state.json') '{"isLogin":true,"connect":true}'
    $null=Wait-Ui 'ready' $true
    $records+=@{case='authorized-websocket-handshake-automatically-makes-ready';pass=$true}
    $api=Join-Path $fixture '.local\api-observed.log';$until=[DateTime]::UtcNow.AddSeconds(25)
    do{if((Test-Path -LiteralPath $api) -and [IO.File]::ReadAllText($api).Contains('GET /api/auth/state')){break};Start-Sleep -Milliseconds 400}while([DateTime]::UtcNow -lt $until)
    if(-not [IO.File]::ReadAllText($api).Contains('GET /api/auth/state')){throw '内置管理前端未访问隔离 API。'}
    $journal=Get-Content -LiteralPath (Join-Path $userRoot 'session.json') -Raw | ConvertFrom-Json
    $pids=@($journal.processes | ForEach-Object {$_.pid})
    if(-not @($journal.processes | Where-Object {$_.kind -eq 'qq'}).Count){throw '专用QQ后代未登记。'}
    $records+=@{case='embedded-management-and-all-helper-ownership';pass=$true;ownedPids=$pids}
    Write-Text (Join-Path $fixture '.local\desktop-host-command.json') '{"sequence":10,"decision":"stop"}'
    $until=[DateTime]::UtcNow.AddSeconds(90)
    do{$app.Refresh();if($app.HasExited){break};Start-Sleep -Milliseconds 500}while([DateTime]::UtcNow -lt $until)
    if(-not $app.HasExited){throw '关闭窗口未清理全部隔离服务。'}
    $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {$_.LocalPort -in @($web,$ws,$napcat)})
    if($listeners.Count){throw '隔离端口尚未释放。'}
    foreach($receipt in $journal.processes){$process=Get-CimInstance Win32_Process -Filter ('ProcessId='+$receipt.pid);if($process -and $process.CreationDate.ToUniversalTime().Ticks.ToString() -eq $receipt.created){throw '隔离后代仍存活。'}}
    if([IO.File]::ReadAllText((Join-Path $work 'login-preserved.txt')) -ne 'fixture-login-state-must-survive-exit'){throw '登录状态文件未保留。'}
    if(-not [IO.File]::ReadAllText($api).Contains('graceful-shutdown')){throw 'Node未执行优雅关闭。'}
    $records+=@{case='close-stops-node-napcat-qq-webview-and-releases-all-ports';pass=$true;ports=@($web,$ws,$napcat);remaining=0;receipt=(Get-Content -LiteralPath (Join-Path $fixture '.local\desktop-host-receipt.json') -Raw | ConvertFrom-Json)}
    $records+=@{case='login-files-preserved';pass=$true}
    $realAfter=@(Get-CimInstance Win32_Process | Where-Object {($_.Name -eq 'QQ.exe' -and $_.CommandLine -notmatch '--type=' -and $_.ExecutablePath -notlike ($fixture+'\*')) -or ($_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.Contains((Join-Path $root 'src\main.js')))} | ForEach-Object {$_.ProcessId.ToString()+':'+$_.CreationDate.ToUniversalTime().Ticks})
    if(($realBefore -join ',') -ne ($realAfter -join ',')){throw '真实QQ或bot进程身份发生变化。'}
    $records+=@{case='real-instances-unchanged';pass=$true}
    @{ok=$true;version=$waiting.version;atUtc=[DateTimeOffset]::UtcNow.ToString('o');fixture=$fixture;exeSha256=(Get-FileHash -LiteralPath $Exe).Hash.ToLowerInvariant();cases=$records;modelCalls=0;qqMessages=0} | ConvertTo-Json -Depth 8 | Tee-Object -FilePath (Join-Path $root '.local\desktop-startup-result-20261023.json')
}finally{if($savedPrefs -ne $null){[IO.File]::WriteAllText($savedPrefsPath,$savedPrefs,$encoding)}}
