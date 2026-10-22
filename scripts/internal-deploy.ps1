param(
  [switch]$Restore,
  [string]$DestinationRoot = (Join-Path $env:APPDATA 'Autodesk/ApplicationPlugins')
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
. (Join-Path $PSScriptRoot 'package-common.ps1')
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$DestinationRoot = [IO.Path]::GetFullPath($DestinationRoot)
$target = Assert-Within (Join-Path $DestinationRoot 'MyCivil3DMcp.bundle') $DestinationRoot
$cache = Join-Path $repo '.package-cache/internal-deploy'
New-Item -ItemType Directory -Force -Path $cache | Out-Null
$sha = [Security.Cryptography.SHA256]::Create()
try { $key = Get-Sha256Hex $sha ([Text.Encoding]::UTF8.GetBytes($target.ToLowerInvariant())) } finally { $sha.Dispose() }
$stateFile = Join-Path $cache ($key + '.json')
$mutex = [Threading.Mutex]::new($false, 'Local\MyCivil3DMcpDeploy')
$owned = $false
$work = $null
$previousPath = $env:Path
function Run([string]$Tool, [string[]]$Arguments) {
  & $Tool @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Tool 실패: 종료 코드 $LASTEXITCODE" }
}
try {
  try { $owned = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owned = $true }
  if (-not $owned) { throw '다른 배포 작업이 진행 중입니다.' }
  Assert-BundleStopped $target
  $previous = if (Test-Path -LiteralPath $stateFile) { Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
  if ($Restore) {
    if (-not $previous -or -not $previous.backup) { throw '복원할 이전 설치가 없습니다.' }
    $backup = Assert-Within $previous.backup $DestinationRoot
    if (-not $backup.StartsWith($target + '.backup-', [StringComparison]::OrdinalIgnoreCase)) { throw '백업 경로가 올바르지 않습니다.' }
    Assert-NoReparse $backup
    [void](Test-Bundle $backup)
    $restored = Invoke-BundleInstall $backup $DestinationRoot
    [IO.File]::WriteAllText($stateFile, (@{ installed=$restored.installed; backup=$null; restoredAt=[DateTime]::UtcNow.ToString('o') } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    Write-Host "이전 설치로 복원했습니다: $($restored.installed)"
    return
  }
  Write-Host '현재 수정본을 이 PC에 내부 배포합니다. 정식 버전과 공개 Release는 변경하지 않습니다.'
  $version = (Get-Content -LiteralPath (Join-Path $repo 'server/package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
  $runtimeConfig = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'node-runtime.json') -Raw | ConvertFrom-Json
  $workRoot = Join-Path $repo '.package-work'
  New-Item -ItemType Directory -Force -Path $workRoot | Out-Null
  Assert-NoReparse $workRoot
  $work = Assert-Within (Join-Path $workRoot ('internal-' + [guid]::NewGuid().ToString('N'))) $workRoot
  New-Item -ItemType Directory -Force -Path $work | Out-Null
  $runtime = Join-Path $target 'Contents/node'
  $node = Join-Path $runtime 'node.exe'
  if (-not (Test-Path -LiteralPath $node) -or (& $node --version).Trim() -ne ('v' + $runtimeConfig.version)) {
    $archive = Join-Path $repo ('.package-cache/node-v' + $runtimeConfig.version + '-win-x64.zip')
    if (-not (Test-Path -LiteralPath $archive)) {
      Write-Host '동봉할 공식 Node 런타임을 준비합니다...'
      Invoke-WebRequest -UseBasicParsing -Uri ('https://nodejs.org/dist/v' + $runtimeConfig.version + '/node-v' + $runtimeConfig.version + '-win-x64.zip') -OutFile $archive
    }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $runtimeConfig.sha256) { throw 'Node 런타임 해시가 다릅니다.' }
    Expand-SafeArchive $archive (Join-Path $work 'runtime')
    $runtime = Join-Path $work ('runtime/node-v' + $runtimeConfig.version + '-win-x64')
    $node = Join-Path $runtime 'node.exe'
  }
  $env:Path = $runtime + [IO.Path]::PathSeparator + $env:Path
  $npm = Join-Path $runtime 'node_modules/npm/bin/npm-cli.js'
  Write-Host '[1/3] DLL과 서버를 빌드합니다...'
  Run dotnet @('build', (Join-Path $repo 'plugin/MyCivil3DMcp.Plugin.csproj'), '-c', 'Release', '-clp:ErrorsOnly')
  Push-Location (Join-Path $repo 'server')
  try {
    if (-not (Test-Path -LiteralPath 'node_modules/typescript/bin/tsc')) { Run $node @($npm, 'ci', '--no-audit', '--no-fund') }
    Run $node @($npm, 'run', 'build')
  } finally { Pop-Location }
  Write-Host '[2/3] 내부 설치 파일을 준비합니다...'
  $bundle = Join-Path $work 'MyCivil3DMcp.bundle'
  $contents = Join-Path $bundle 'Contents'
  foreach ($folder in @('plugin','server','installer','licenses')) { New-Item -ItemType Directory -Force -Path (Join-Path $contents $folder) | Out-Null }
  foreach ($name in @('MyCivil3DMcp.Plugin.dll','MyCivil3DMcp.Plugin.deps.json','MyCivil3DMcp.Plugin.runtimeconfig.json')) {
    Copy-Item -LiteralPath (Join-Path $repo "plugin/bin/Release/net8.0-windows/$name") -Destination (Join-Path $contents 'plugin')
  }
  Copy-Item -LiteralPath $runtime -Destination (Join-Path $contents 'node') -Recurse
  Copy-Item -LiteralPath (Join-Path $runtime 'LICENSE') -Destination (Join-Path $contents 'licenses/Node-LICENSE.txt')
  Copy-Item -LiteralPath (Join-Path $repo 'plugin/UI/Assets/simple-icons-LICENSE.md') -Destination (Join-Path $contents 'licenses/Simple-Icons-LICENSE.md')
  $server = Join-Path $contents 'server'
  foreach ($name in @('build','skills','knowledge-defaults','setup','package.json','package-lock.json')) { Copy-Item -LiteralPath (Join-Path $repo "server/$name") -Destination $server -Recurse }
  Run $node @($npm, 'ci', '--prefix', $server, '--omit=dev', '--no-audit', '--no-fund')
  $quota = Join-Path $server 'claude-quota'
  New-Item -ItemType Directory -Force -Path $quota | Out-Null
  foreach ($name in @('readQuota.mjs','package.json','package-lock.json')) { Copy-Item -LiteralPath (Join-Path $repo "server/claude-quota/$name") -Destination $quota }
  Run $node @($npm, 'ci', '--prefix', $quota, '--omit=dev', '--no-audit', '--no-fund')
  foreach ($name in @('install.ps1','package-common.ps1','release-public-key.xml','update.ps1','install-exe.ps1')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $contents 'installer') }
  $metadata = @{ version=$version; channel='internal'; nodeVersion=$runtimeConfig.version; builtAt=[DateTime]::UtcNow.ToString('o'); repository=$repo; supportedCivil3D=@('2025') }
  $metadata | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $contents 'version.json') -Encoding UTF8
  $metadata | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $contents 'internal-deployment.json') -Encoding UTF8
  @"
<?xml version="1.0" encoding="utf-8"?>
<ApplicationPackage SchemaVersion="1.0" AppVersion="$version" Name="MyCivil3DMcp" Description="My Civil 3D MCP - Internal" Author="MyCivil3DMcp" ProductCode="{$([guid]::NewGuid().ToString().ToUpperInvariant())}" UpgradeCode="{E49DD37D-13B7-4DA8-A616-85109188D819}">
  <Components>
    <RuntimeRequirements OS="Win64" Platform="Civil3D" SeriesMin="R25.0" SeriesMax="R25.0" />
    <ComponentEntry AppName="MyCivil3DMcp" AppDescription="Internal build" AppType=".Net" ModuleName="./Contents/plugin/MyCivil3DMcp.Plugin.dll" LoadOnAutoCADStartup="True" />
  </Components>
</ApplicationPackage>
"@ | Set-Content -LiteralPath (Join-Path $bundle 'PackageContents.xml') -Encoding UTF8
  Write-BundleManifest $bundle
  [void](Test-Bundle $bundle)
  Write-Host '[3/3] 기존 설치를 백업하고 교체합니다...'
  Assert-BundleStopped $target
  $wasInternal = Test-Path -LiteralPath (Join-Path $target 'Contents/internal-deployment.json')
  $result = Invoke-BundleInstall $bundle $DestinationRoot
  $backup = if ($wasInternal -and $previous -and $previous.backup -and (Test-Path -LiteralPath $previous.backup)) { $previous.backup } else { $result.backup }
  @{ installed=$result.installed; backup=$backup; version=$version; deployedAt=[DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8
  Write-Host "`n내부 배포 완료: $($result.installed)"
  Write-Host "정식 버전 유지: $version / 내부 데이터: %LOCALAPPDATA%\MyCivil3DMcp\internal-data"
  Write-Host 'Civil 3D를 평소처럼 실행하면 수정본 팔레트가 자동으로 열립니다. NETLOAD는 필요 없습니다.'
  Write-Host '이전 설치로 복원: 내부배포.bat -Restore'
} finally {
  $env:Path = $previousPath
  if ($work) { Remove-OwnedDirectory $work (Join-Path $repo '.package-work') }
  if ($owned) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
