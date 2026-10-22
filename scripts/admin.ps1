$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$server = Join-Path $repo 'server'
$configFile = Join-Path $repo '.drive-deploy.json'
if (Test-Path -LiteralPath $configFile) {
  $config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $env:MY_CIVIL3D_DRIVE_DIR = if ($config.PSObject.Properties['collectionRoot'] -and $config.collectionRoot) { $config.collectionRoot } else { $config.driveRoot }
}

$command = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$node = if ($command) { $command.Source } else { Join-Path $env:APPDATA 'Autodesk\ApplicationPlugins\MyCivil3DMcp.bundle\Contents\node\node.exe' }
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) {
  throw 'Node.js를 찾지 못했습니다. 프로그램 설치 EXE를 실행하거나 Node.js를 설치해 주세요.'
}

$mutex = New-Object Threading.Mutex($false, 'Local\MyCivil3DMcpAdmin')
$owned = $false
try {
  try { $owned = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owned = $true }
  if (-not $owned) { throw '관리자 프로그램이 이미 실행 중입니다.' }
  Push-Location $server
  try {
    $entry = Join-Path $server 'build\admin\console.js'
    $needed = $false
    foreach ($name in @('console','menu','worker','adminWorker','terminal','jobs','jobTypes','caseCleanup')) {
      if (-not (Test-Path -LiteralPath (Join-Path $server "build\admin\$name.js"))) { $needed = $true }
    }
    if (-not $needed) {
      $builtAt = (Get-Item -LiteralPath $entry).LastWriteTimeUtc
      $sources = @(Get-ChildItem -LiteralPath (Join-Path $server 'src') -Recurse -File -Filter '*.ts')
      $sources += Get-Item -LiteralPath (Join-Path $server 'tsconfig.json')
      foreach ($file in $sources) {
        if ($file.LastWriteTimeUtc -gt $builtAt) { $needed = $true; break }
      }
    }
    if ($needed) {
      Write-Host '[준비] 변경된 관리자 프로그램을 빌드합니다...'
      $compiler = Join-Path $server 'node_modules\typescript\bin\tsc'
      if (-not (Test-Path -LiteralPath $compiler)) { throw '빌드 도구가 없습니다. server 폴더에서 npm ci를 먼저 실행해 주세요.' }
      & $node $compiler
      if ($LASTEXITCODE -ne 0) { throw '관리자 프로그램 빌드 실패' }
    }
    & $node $entry @args
    if ($LASTEXITCODE -ne 0) { throw '관리자 프로그램 실행 실패' }
  } finally { Pop-Location }
} finally {
  if ($owned) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
