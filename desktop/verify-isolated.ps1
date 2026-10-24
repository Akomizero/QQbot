param([string]$Exe=(Join-Path $PSScriptRoot 'dist\0.2.1\Feiyu.exe'))
$ErrorActionPreference='Stop'
$root=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$fixture=Join-Path $root ('.local\desktop-acceptance-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $fixture 'src'),(Join-Path $fixture 'scripts'),(Join-Path $fixture 'node_modules\ws'),(Join-Path $fixture '.local') -Force | Out-Null
$encoding=New-Object Text.UTF8Encoding($false)
function Write-Utf8([string]$Name,[string]$Text){[IO.File]::WriteAllText((Join-Path $fixture $Name),$Text,$encoding)}
function Free-Port {$listener=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,0);$listener.Start();$port=$listener.LocalEndpoint.Port;$listener.Stop();return $port}
$web=Free-Port;$onebot=Free-Port;while($onebot -eq $web){$onebot=Free-Port}
Write-Utf8 'package.json' '{"type":"module"}'
Write-Utf8 'node_modules\ws\package.json' '{}'
Write-Utf8 '.env' ("QQBOT_WEB_PORT=$web`nQQBOT_ONEBOT_PORT=$onebot`n")
Write-Utf8 '.local\desktop-fixture.marker' 'feiyu-desktop-isolated-v1'
Copy-Item -LiteralPath (Join-Path $root 'src\launcher.js'),(Join-Path $root 'src\desktop-lifecycle.js') -Destination (Join-Path $fixture 'src')
$main=@'
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { startDesktopLifecycle } from './desktop-lifecycle.js';
const helper=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
helper.unref();
const log=new URL('../.local/api-observed.log',import.meta.url);
const web=createServer((req,res)=>{appendFileSync(log,req.method+' '+req.url+'\n');res.writeHead(200,{'content-type':'application/json'});res.end('{"setupRequired":false,"authenticated":false}');});
const onebot=createServer((req,res)=>res.end('fixture'));
await new Promise(resolve=>web.listen(WEBPORT,'127.0.0.1',resolve));
await new Promise(resolve=>onebot.listen(ONEBOTPORT,'127.0.0.1',resolve));
let lifecycle;
lifecycle=await startDesktopLifecycle(async()=>{appendFileSync(log,'graceful-shutdown\n');web.close();onebot.close();await lifecycle.close();});
// Deliberately leave a helper alive: desktop must clean it after graceful shutdown.
'@
Write-Utf8 'src\main.js' ($main.Replace('WEBPORT',[string]$web).Replace('ONEBOTPORT',[string]$onebot))
$node=(Get-Command node).Source
$desktopPrefs=Join-Path $env:LOCALAPPDATA 'FeiyuBot\desktop.json'
$savedPrefs=if(Test-Path -LiteralPath $desktopPrefs){[IO.File]::ReadAllText($desktopPrefs)}else{$null}
$realBefore=@(Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object {$_.CommandLine -and $_.CommandLine.Contains((Join-Path $root 'src\main.js'))} | ForEach-Object {$_.ProcessId})
$records=@();$app=$null;$legacy=$null
function Call-Control([string]$Action){
    for($attempt=0;$attempt -lt 4;$attempt++){
        $info=New-Object Diagnostics.ProcessStartInfo
        $info.FileName=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $info.Arguments='-NoProfile -ExecutionPolicy Bypass -File "'+(Join-Path $PSScriptRoot 'control.ps1')+'" -ProjectRoot "'+$fixture+'" -OwnerPid '+$app.Id+' -Action '+$Action
        $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true;$info.StandardOutputEncoding=[Text.Encoding]::UTF8
        $control=New-Object Diagnostics.Process;$control.StartInfo=$info;[void]$control.Start()
        $raw=$control.StandardOutput.ReadLine()
        if(-not $control.WaitForExit(90000)){throw '隔离控制器未在限时内退出。'}
        $control.Dispose()
        $result=$raw | ConvertFrom-Json
        if($result.ok -or -not $result.error.Contains('仍在进行')){return $result}
        Start-Sleep -Milliseconds 400
    }
    throw ('控制器持续忙碌：'+$result.error)
}
function Close-App([int]$Sequence=2) {
    Write-Utf8 '.local\desktop-host-command.json' ('{"sequence":'+$Sequence+',"decision":"stop"}')
    Write-Output ('CLOSING_ISOLATED_WINDOW appPid='+$app.Id+' fixture='+$fixture)
    $deadline=[DateTime]::UtcNow.AddSeconds(70)
    do {
        $app.Refresh();if($app.HasExited){break};Start-Sleep -Milliseconds 800
    }while([DateTime]::UtcNow -lt $deadline)
    if(-not $app.HasExited){throw '隔离桌面窗口未完成退出，需查看失败提示。'}
    $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {$_.LocalPort -in @($web,$onebot)})
    if($listeners.Count){throw '隔离测试端口仍被占用。'}
    $key=$fixture.ToLowerInvariant()
    $sha=[Security.Cryptography.SHA256]::Create();try{$identity=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($key)))).Replace('-','').ToLowerInvariant().Substring(0,20)}finally{$sha.Dispose()}
    $journal=Get-Content -LiteralPath (Join-Path $env:LOCALAPPDATA ('FeiyuBot\projects\'+$identity+'\session.json')) -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach($receipt in $journal.processes){$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$receipt.pid);if($p -and $p.CreationDate.ToUniversalTime().Ticks.ToString() -eq $receipt.created){throw '隔离测试子进程仍存活。'}}
}
try {
    # Legacy service is entirely synthetic and uses ephemeral loopback ports.
    $legacy=Start-Process -FilePath $node -ArgumentList ('"'+(Join-Path $fixture 'src\main.js')+'"') -WorkingDirectory $fixture -WindowStyle Hidden -PassThru
    Start-Sleep -Seconds 1
    $app=Start-Process -FilePath $Exe -ArgumentList ('--verify-fixture --project "'+$fixture+'"') -WindowStyle Normal -PassThru
    Start-Sleep -Seconds 3
    $status=Call-Control 'Status'
    if(-not $status.ok -or -not $status.needsTakeover -or $status.managed -or $status.ownedCount -ne 0){throw ('未正确识别未接管的旧服务：'+($status | ConvertTo-Json -Compress))}
    $records+=@{case='legacy-detected-unowned';pass=$true;appPid=$app.Id;workerPid=$legacy.Id;webPort=$web;onebotPort=$onebot}
    Write-Utf8 '.local\desktop-host-command.json' '{"sequence":1,"decision":"cancel"}'
    $until=[DateTime]::UtcNow.AddSeconds(30)
    $receiptFile=Join-Path $fixture '.local\desktop-host-receipt.json'
    $receipt=$null
    do{
        if(Test-Path -LiteralPath $receiptFile){
            try{$candidate=Get-Content -LiteralPath $receiptFile -Raw | ConvertFrom-Json;if($candidate.sequence -eq 1 -and $candidate.stage -eq 'cancelled-unowned-close'){$receipt=$candidate;break}}catch{}
        }
        Start-Sleep -Milliseconds 300
    }while([DateTime]::UtcNow -lt $until)
    $app.Refresh()
    if($receipt.stage -ne 'cancelled-unowned-close' -or $app.HasExited){throw '取消接管后窗口未保持打开。'}
    $records+=@{case='unowned-close-cancel-keeps-window-and-legacy-service';pass=$true}
    Close-App
    $records+=@{case='takeover-close-releases-ports-and-all-recorded-processes';pass=$true;exitedAppPid=$app.Id;webPort=$web;onebotPort=$onebot;remainingListeners=0}
    # Clean restart without a NapCat installation must fail atomically instead
    # of leaving a partial Node-only stack behind. Full embedded-front-end and
    # graceful-shutdown coverage lives in verify-startup.ps1 with a NapCat stub.
    Remove-Item -LiteralPath (Join-Path $fixture '.local\desktop-host-command.json')
    $app=Start-Process -FilePath $Exe -ArgumentList ('--verify-fixture --project "'+$fixture+'"') -WindowStyle Normal -PassThru
    Start-Sleep -Seconds 3
    Write-Utf8 '.local\desktop-host-command.json' '{"sequence":3,"action":"start"}'
    $until=[DateTime]::UtcNow.AddSeconds(40)
    do{$start=Get-Content -LiteralPath $receiptFile -Raw | ConvertFrom-Json;if($start.sequence -eq 3){break};Start-Sleep -Milliseconds 400}while([DateTime]::UtcNow -lt $until)
    if($start.stage -ne 'operation-failed' -or -not $start.error.Contains('NapCat')){throw '桌面 Start 操作未完成或未明确报告隔离依赖缺失。'}
    $records+=@{case='desktop-start-action-returns-without-pipe-eof-hang';pass=$true}
    $status=Call-Control 'Status';if($status.ownedCount -ne 0 -or $status.panelReady){throw '缺少 NapCat 时留下了半启动后台。'}
    $records+=@{case='missing-napcat-fails-without-partial-stack';pass=$true;ownedCount=$status.ownedCount;panelReady=$status.panelReady}
    Close-App 4
    $records+=@{case='failed-start-window-closes-with-no-residue';pass=$true;exitedAppPid=$app.Id;webPort=$web;onebotPort=$onebot;remainingListeners=0;receipt=(Get-Content -LiteralPath $receiptFile -Raw | ConvertFrom-Json)}
    $realAfter=@(Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object {$_.CommandLine -and $_.CommandLine.Contains((Join-Path $root 'src\main.js'))} | ForEach-Object {$_.ProcessId})
    if(($realBefore -join ',') -ne ($realAfter -join ',')){throw '真实项目进程发生了变化。'}
    $records+=@{case='real-project-worker-preserved';pass=$true}
    @{ok=$true;atUtc=[DateTimeOffset]::UtcNow.ToString('o');fixture=$fixture;exeSha256=(Get-FileHash -LiteralPath $Exe).Hash.ToLowerInvariant();cases=$records;realQQLoginTested=$false;realQQRestarted=$false;modelCalls=0;qqSends=0} | ConvertTo-Json -Depth 8 | Tee-Object -FilePath (Join-Path $root '.local\desktop-isolated-result-20261023.json')
} finally {
    if($savedPrefs -ne $null){[IO.File]::WriteAllText($desktopPrefs,$savedPrefs,$encoding)}elseif(Test-Path -LiteralPath $desktopPrefs){Remove-Item -LiteralPath $desktopPrefs}
    # If verification fails, preserve the window and fixture for diagnosis rather
    # than broad-killing any process. It can be closed through the same UI.
}
