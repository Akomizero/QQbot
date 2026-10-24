param([switch]$Offline)
$ErrorActionPreference='Stop'
$root=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$version='0.2.10'
$output=Join-Path $PSScriptRoot ('dist\'+$version)
Push-Location $PSScriptRoot
try {
    if(-not $Offline){ & dotnet restore Feiyu.Desktop.csproj --locked-mode --disable-parallel; if($LASTEXITCODE){throw '依赖还原失败。'} }
    & dotnet publish Feiyu.Desktop.csproj -c Release --no-restore -o $output
    if($LASTEXITCODE){throw 'EXE 构建失败。'}
    # Explicit release allowlist. No recursive project copy, no .env/data/.local/NapCat.
    $allowed=@('Feiyu.exe','install.ps1','README.md','build-manifest.json')
    foreach($file in @(Get-ChildItem -LiteralPath $output -File)){if($file.Name -notin $allowed){Remove-Item -LiteralPath $file.FullName}}
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install.ps1') -Destination (Join-Path $output 'install.ps1') -Force
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'README.md') -Destination (Join-Path $output 'README.md') -Force
    $inputs=@()
    foreach($relative in @('desktop\Program.cs','desktop\NapCatPage.cs','desktop\ProcessJob.cs','desktop\ExitPolicy.cs','desktop\control.ps1','desktop\Feiyu.Desktop.csproj','desktop\packages.lock.json','desktop\global.json','desktop\build.ps1','desktop\install.ps1','desktop\app.manifest','desktop\NuGet.Config','public\index.html','public\app.js','public\styles.css','package-lock.json')){
        $file=Join-Path $root $relative
        $inputs+=@{file=$relative.Replace('\','/');sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
    }
    $manifest=@{version=$version;builtAtUtc=[DateTimeOffset]::UtcNow.ToString('o');rid='win-x64';sdk=(& dotnet --version);webView2Sdk='1.0.3537.50';selfContained=$true;embeddedFrontend=$true;externalDependencies=@('Node.js >=20.9','project src/node_modules','dedicated NapCat/QQ','WebView2 Runtime');privateDataIncluded=$false;inputs=$inputs;files=@(@('Feiyu.exe','install.ps1','README.md') | ForEach-Object {@{file=$_;sha256=(Get-FileHash -LiteralPath (Join-Path $output $_) -Algorithm SHA256).Hash.ToLowerInvariant()}})}
    $manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $output 'build-manifest.json') -Encoding UTF8
    $zip=Join-Path $PSScriptRoot ('dist\Feiyu-Desktop-'+$version+'-win-x64.zip')
    Compress-Archive -LiteralPath @($allowed | ForEach-Object {Join-Path $output $_}) -DestinationPath $zip -Force
    Write-Output ('EXE: '+(Join-Path $output 'Feiyu.exe'))
    Write-Output ('Package: '+$zip)
} finally {Pop-Location}
