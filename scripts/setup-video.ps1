param([string]$PythonExe = 'py')
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$runtime = Join-Path $projectRoot '.local\video-runtime'
& $PythonExe -m venv $runtime
if ($LASTEXITCODE -ne 0) { throw 'Python 3.11 or newer is required.' }
$runtimePython = Join-Path $runtime 'Scripts\python.exe'
& $runtimePython -m pip install 'faster-whisper==1.2.1'
if ($LASTEXITCODE -ne 0) { throw 'Could not install the speech runtime.' }
$modelPath = Join-Path $projectRoot '.local\video-asr-model'
$env:QQBOT_VIDEO_MODEL_DIR = $modelPath
$env:HF_HUB_DISABLE_XET = '1'
& $runtimePython -c "import os; from huggingface_hub import snapshot_download; snapshot_download('Systran/faster-whisper-base',local_dir=os.environ['QQBOT_VIDEO_MODEL_DIR'],allow_patterns=['config.json','model.bin','tokenizer.json','vocabulary.*','preprocessor_config.json'])"
if ($LASTEXITCODE -ne 0) { throw 'Could not download the multilingual speech model.' }
Write-Output 'Video speech runtime is ready. FFmpeg is installed by npm ci.'
