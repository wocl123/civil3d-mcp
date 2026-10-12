$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$configFile = Join-Path $repo '.drive-deploy.json'
if (Test-Path -LiteralPath $configFile) {
  $config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $env:MY_CIVIL3D_DRIVE_DIR = if ($config.PSObject.Properties['collectionRoot'] -and $config.collectionRoot) { $config.collectionRoot } else { $config.driveRoot }
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw '관리자 PC에 Node.js가 필요합니다.' }
$mutex = New-Object Threading.Mutex($false, 'Local\MyCivil3DMcpAdmin')
$owned = $false
try {
  try { $owned = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owned = $true }
  if (-not $owned) { throw '관리자 프로그램이 이미 실행 중입니다.' }
  Push-Location (Join-Path $repo 'server')
  try {
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw '관리자 프로그램 빌드 실패' }
    & node build/admin/console.js @args
    if ($LASTEXITCODE -ne 0) { throw '관리자 프로그램 실행 실패' }
  } finally { Pop-Location }
} finally { if ($owned) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
