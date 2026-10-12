# 자동 업데이트에서 설치 EXE를 실행한다(update.ps1이 부른다).
# 설치된 번들에 들어 있는 공개 키로 EXE 서명을 먼저 확인한 뒤에만 실행한다.
param(
  [Parameter(Mandatory=$true)][string]$Archive,
  [Parameter(Mandatory=$true)][string]$DataDir,
  [string]$DestinationRoot,
  [switch]$SkipRunningCheck   # 시험용: 실행 중 확인과 "앱 및 기능" 등록을 건너뛴다
)
$ErrorActionPreference = 'Stop'

$metadata = Get-Content -LiteralPath ($Archive + '.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$bytes = [IO.File]::ReadAllBytes($Archive)
$hash = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($bytes.LongLength -ne $metadata.size -or $hash -ne $metadata.sha256) {
  throw 'Installer EXE hash mismatch.'
}

$rsa = New-Object Security.Cryptography.RSACryptoServiceProvider
try {
  $rsa.FromXmlString([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'release-public-key.xml')))
  $signature = [Convert]::FromBase64String($metadata.signature)
  if (-not $rsa.VerifyData($bytes, 'SHA256', $signature)) {
    throw 'Installer EXE signature mismatch.'
  }
} finally {
  $rsa.Dispose()
}

if (-not $DestinationRoot) {
  $DestinationRoot = Join-Path $env:APPDATA 'Autodesk\ApplicationPlugins'
}

$logFolder = Join-Path $DataDir ('logs\' + (Get-Date -Format 'yyyy-MM-dd'))
New-Item -ItemType Directory -Path $logFolder -Force | Out-Null
$log = Join-Path $logFolder 'installer.log'

$arguments = @(
  '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART',
  ('/DIR="' + (Join-Path $DestinationRoot 'MyCivil3DMcp.bundle') + '"'),
  ('/DataDir="' + $DataDir + '"'),
  ('/LOG="' + $log + '"')
)
if ($SkipRunningCheck) {
  $arguments += '/Sandbox=1'
}

$process = Start-Process -FilePath $Archive -ArgumentList $arguments -PassThru -Wait
if ($process.ExitCode -ne 0) {
  throw "Installer failed (exit code $($process.ExitCode)). See $log"
}
