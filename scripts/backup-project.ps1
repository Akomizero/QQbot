param([string]$DestinationRoot)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($package.name -ne 'qq-group-bot') { throw 'Unexpected project directory.' }
if (-not $DestinationRoot) { $DestinationRoot = Join-Path (Split-Path -Parent $projectRoot) 'backups' }
New-Item -ItemType Directory -Path $DestinationRoot -Force | Out-Null
$backupRoot = (Resolve-Path -LiteralPath $DestinationRoot).Path
$createdAt = [DateTime]::UtcNow.AddHours(8)
$backupName = 'qq-group-bot-' + $createdAt.ToString('yyyyMMdd-HHmmss') + '.zip'
$archivePath = Join-Path $backupRoot $backupName
$partialPath = $archivePath + '.incomplete'

$files = [System.Collections.Generic.Dictionary[string,string]]::new([System.StringComparer]::OrdinalIgnoreCase)
function Include-File([string]$relative) {
    $candidate = Join-Path $projectRoot $relative
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { return }
    $absolute = (Resolve-Path -LiteralPath $candidate).Path
    if (-not $absolute.StartsWith($projectRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Backup source escaped the project.' }
    $files[$relative.Replace('\','/')] = $absolute
}
foreach ($folder in @('src','public','data','docs','scripts','test','tools','.local\chatgpt-images','.local\reply-recovery','.local\recovery-deliveries','.local\video-recommendations')) {
    $folderPath = Join-Path $projectRoot $folder
    if (Test-Path -LiteralPath $folderPath -PathType Container) {
        foreach ($item in Get-ChildItem -LiteralPath $folderPath -File -Recurse -Force) {
            Include-File $item.FullName.Substring($projectRoot.Length + 1)
        }
    }
}
foreach ($relative in @('package.json','package-lock.json','README.md','.env','.env.example','.gitignore',
    '.local\admin-auth.json','.local\admin-auth.setup.lock','.local\proactive-chat-state.json','.local\sticker-learning-state.json',
    '.local\power-settings-before-20261021.json',
    '.local\video-discovery-state.json','.local\video-discovery-ui-20261021.png','.local\video-topic-sharing-ui-20261022.png',
    '.local\visual-memory-ui-20261022.png','.local\knowledge-growth-ui-20261022.png','.local\member-identity-ui-20261022.png',
    '.local\memory-maintenance-ui-20261022.png',
    '.local\personality-growth-ui-20261022.png',
    '.local\knowledge-learning-state.json','.local\model-diagnostics.json',
    '.local\model-proxy.json','.local\diagnostic-deliveries-20261021.json',
    '.local\model-private-pool-health-check-20261021.json','.local\dedicated-bot-route-check-20261021.json',
    '.local\image-context-ui-20261021.png','.local\image-followup-live-check-20261021.json',
    '.local\verify-image-followup-live-20261021.mjs',
    '.local\member-dialogue-recovery-20261021.json',
    '.local\member-dialogue-ui-20261021.png',
    '.local\forward-read-metadata-20261021.json','.local\forward-reading-ui-20261021.png',
    '.local\serper-source-ui-20261021.png','.local\serper-source-read-20261021.json',
    '.local\forward-media-inspection-20261021.json','.local\forward-media-repair-ui-20261021.png',
    '.local\forward-complete-read-20261021.json','.local\forward-nine-image-ui-20261021.png',
    '.local\serper-retry-live-read-20261021.json','.local\serper-recovery-delivery-20261021.json',
    '.local\forward-recovery-delivery-20261021.json','.local\chatgpt-imagegen-ui-20261021.png',
    '.local\p0-check-metadata-20261021.json','.local\p0-live-check-metadata-20261021.json',
    '.local\p0-management-diagnostics-20261021.png',
    '.local\p0-check-metadata.json','.local\member-live-check-metadata-20261021.json','.local\member-impressions-ui-20261021.png',
    '.local\group-diagnostic-retries-20261021.json','.local\retry-group-diagnostics-20261021.mjs',
    '.local\model-route-live-recheck-20261021.json','.local\model-network-control-check-20261021.json',
    '.local\verify-stickers-20261020.mjs','.local\verify-knowledge.mjs','.local\verify-fallback-emoji.mjs',
    '.local\frontend-stickers-20261020.png','.local\verify-content-video-20261020.mjs',
    '.local\frontend-content-filter-20261020.png','.local\bridge-connected-20261020.png',
    '.local\frontend-knowledge-learning-20261020.png','.local\frontend-group-personas-20261020.png',
    '.local\frontend-model-retry-20261020.png','.local\frontend-long-reply-20261020.png',
    '.local\frontend-group-knowledge-20261020.png','.local\frontend-discussion-20261020.png',
    '.local\frontend-game-announcement-20261020.png','.local\announcement-sample-20261020.txt',
    '.local\announcement-sample-20261020-1.png','.local\announcement-sample-20261020-2.png',
    '.local\announcement-check-metadata.json','.local\frontend-content-summary-20261020.png',
    '.local\summary-sample-20261020.txt','.local\summary-sample-20261020-1.png',
    '.local\summary-sample-20261020-2.png','.local\summary-check-metadata.json',
    '.local\frontend-character-recognition-20261020.png','.local\character-baseline-20261020.txt',
    '.local\character-enhanced-20261020.txt','.local\character-check-metadata.json',
    '.local\frontend-summary-dates-20261020.png','.local\summary-dates-sample-20261020.txt',
    '.local\summary-dates-sample-20261020-1.png','.local\summary-dates-check-metadata.json',
    '.local\frontend-card-layout-20261020.png','.local\card-layout-sample-20261020.txt',
    '.local\card-layout-sample-20261020-1.png','.local\card-layout-check-metadata.json',
    '.local\card-layout-live-20261020.txt','.local\card-layout-live-20261020-1.png',
    '.local\card-layout-live-20261020-2.png')) { Include-File $relative }

$stickerIndexPath = Join-Path $projectRoot '.local\stickers\index.json'
$stickerIndexHash = $null
if (Test-Path -LiteralPath $stickerIndexPath -PathType Leaf) {
    $stickerIndexHash = (Get-FileHash -LiteralPath $stickerIndexPath -Algorithm SHA256).Hash
    Include-File '.local\stickers\index.json'
    try { $stickers = Get-Content -LiteralPath $stickerIndexPath -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { throw 'Sticker index could not be parsed; no backup was created.' }
    foreach ($sticker in $stickers) {
        if ($sticker.id -notmatch '^[a-f0-9-]{36}$') { throw 'Invalid sticker asset identifier.' }
        $relative = '.local\stickers\' + $sticker.id + '.image'
        if (-not (Test-Path -LiteralPath (Join-Path $projectRoot $relative) -PathType Leaf)) { throw 'Sticker asset is missing.' }
        Include-File $relative
    }
}
$napcatConfig = Join-Path $projectRoot '.local\napcat\bot-workdir\config'
if (Test-Path -LiteralPath $napcatConfig -PathType Container) {
    foreach ($item in Get-ChildItem -LiteralPath $napcatConfig -File -Recurse -Force) {
        Include-File $item.FullName.Substring($projectRoot.Length + 1)
    }
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$manifest = [System.Collections.Generic.List[object]]::new()
$zip = [System.IO.Compression.ZipFile]::Open($partialPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($relative in @($files.Keys | Sort-Object)) {
        $source = $files[$relative]
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $source, $relative, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
        $manifest.Add([pscustomobject]@{ path=$relative; length=(Get-Item -LiteralPath $source).Length; sha256=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() })
    }
    $metadata = [pscustomobject]@{ project='qq-group-bot'; createdAt=$createdAt.ToString('yyyy-MM-ddTHH:mm:ss') + '+08:00'; files=$manifest }
    $manifestEntry = $zip.CreateEntry('BACKUP-MANIFEST.json')
    $writer = [System.IO.StreamWriter]::new($manifestEntry.Open(), [System.Text.UTF8Encoding]::new($false))
    try { $writer.Write(($metadata | ConvertTo-Json -Depth 8)) } finally { $writer.Dispose() }
    $guide = @'
# Restore this local backup

1. Run `powershell -File scripts/stop-bridge.ps1` in this project to stop its bridge and supervisor before restoring. Keep the original NapCat/QQ installation and login-session directories.
2. Extract this ZIP into an empty folder. Keep BACKUP-MANIFEST.json for checksum comparison.
3. Use Node.js 20.9 or newer; run `npm ci` in the extracted project folder.
4. `.env`, data/, .local/admin-auth.json, stickers and throttle states are included. They preserve server keys, administrator login and bot data. Do not publish or share this archive.
5. NapCat configuration files are included for reference. Restore them only to the corresponding existing NapCat instance when needed. This archive does not include NapCat/QQ binaries or their login sessions, node_modules, development fixtures or logs.
6. Confirm that the local web and OneBot ports from .env are free, then run `npm start`. Reconnect the existing NapCat reverse WebSocket client. No QQ/NapCat restart is required for restoring just the bot bridge.
7. Open the management page, log in with the existing admin password and confirm OneBot is connected.
8. For local video speech transcription, install Python 3.11+ and run `powershell -File scripts/setup-video.ps1`. The Python environment and model weights are recreated rather than bundled. Video subtitles and image frame extraction do not require this Python environment.
9. Run `powershell -File scripts/install-autostart.ps1` to install current-user login startup, crash recovery and keep-awake behavior. It uses a scheduled task when available, otherwise the current-user Startup folder. True system sleep, power-off and logout cannot run local bot code; the supervisor prevents automatic system sleep while active.
10. If `.local/model-proxy.json` is present, it includes private proxy credentials. Keep it private and retain the existing FlClashCore.exe installation and resourceDir referenced in that file. Update those absolute paths if restoring on a different machine. The binary and GeoIP resources are not bundled; the bridge copies the required existing resources into its private proxy home on startup. The matching model proxy URL is preserved in `.env`.

BACKUP-MANIFEST.json lists SHA-256 checksums for every project file. The backup script reads back every ZIP entry and verifies its hash before declaring success. The adjacent .sha256 file protects the archive as a whole.
'@
    $guideEntry = $zip.CreateEntry('RESTORE.md')
    $writer = [System.IO.StreamWriter]::new($guideEntry.Open(), [System.Text.UTF8Encoding]::new($false))
    try { $writer.Write($guide) } finally { $writer.Dispose() }
} finally { $zip.Dispose() }

if ($stickerIndexHash -and (Get-FileHash -LiteralPath $stickerIndexPath -Algorithm SHA256).Hash -ne $stickerIndexHash) {
    throw 'Sticker library changed during backup. The incomplete archive was kept; run the backup again.'
}
$zip = [System.IO.Compression.ZipFile]::OpenRead($partialPath)
try {
    foreach ($item in $manifest) {
        $entry = $zip.GetEntry($item.path)
        if (-not $entry -or $entry.Length -ne $item.length) { throw 'Archive verification failed.' }
        $stream = $entry.Open()
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try { $digest = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
        finally { $stream.Dispose(); $sha.Dispose() }
        if ($digest -ne $item.sha256) { throw 'Archive checksum mismatch.' }
    }
} finally { $zip.Dispose() }
Rename-Item -LiteralPath $partialPath -NewName $backupName
$archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText($archivePath + '.sha256', $archiveHash + '  ' + $backupName + [Environment]::NewLine)
[pscustomobject]@{ Path=$archivePath; Files=$manifest.Count; SizeMB=[Math]::Round((Get-Item -LiteralPath $archivePath).Length / 1MB, 2); Verified=$true; CreatedAt=$metadata.createdAt } | ConvertTo-Json -Compress
