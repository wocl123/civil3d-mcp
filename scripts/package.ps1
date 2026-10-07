param([string]$AcadDir = 'C:\Program Files\Autodesk\AutoCAD 2025', [string]$NodeArchive)
. (Join-Path $PSScriptRoot 'package-common.ps1')
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'node-runtime.json') -Raw | ConvertFrom-Json
$cache = Join-Path $repo '.package-cache'
$workRoot = Join-Path $repo '.package-work'
$dist = Join-Path $repo 'dist'
New-Item -ItemType Directory -Path $cache,$workRoot,$dist -Force | Out-Null
Assert-NoReparse $cache; Assert-NoReparse $workRoot; Assert-NoReparse $dist
function Run([string]$Tool, [string[]]$Arguments) {
  & $Tool @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Tool 실패: 종료 코드 $LASTEXITCODE" }
}
$archiveName = "node-v$($config.version)-win-x64.zip"
if (-not $NodeArchive) {
  $NodeArchive = Join-Path $cache $archiveName
  if (-not (Test-Path -LiteralPath $NodeArchive)) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$($config.version)/$archiveName" -OutFile $NodeArchive
  }
}
if ((Get-FileHash -LiteralPath $NodeArchive -Algorithm SHA256).Hash -ne $config.sha256) { throw 'Node 배포본 해시가 고정값과 다릅니다.' }
$work = Assert-Within (Join-Path $workRoot ([guid]::NewGuid().ToString('N'))) $workRoot
New-Item -ItemType Directory -Path $work | Out-Null
$release = Join-Path $work 'release'
$bundle = Join-Path $release 'MyCivil3DMcp.bundle'
$contents = Join-Path $bundle 'Contents'
try {
  $expanded = Join-Path $work 'runtime'
  Expand-SafeArchive $NodeArchive $expanded
  $runtime = Join-Path $expanded "node-v$($config.version)-win-x64"
  $node = Join-Path $runtime 'node.exe'
  $npm = Join-Path $runtime 'node_modules/npm/bin/npm-cli.js'
  $env:Path = $runtime + [IO.Path]::PathSeparator + $env:Path
  if ((& $node --version).Trim() -ne "v$($config.version)") { throw 'Node 실행 버전이 다릅니다.' }
  Run dotnet @('build',(Join-Path $repo 'plugin/MyCivil3DMcp.Plugin.csproj'),'-c','Release',"-p:AcadDir=$AcadDir",'-clp:ErrorsOnly')
  # tsc는 개발 의존성이다. 빌드 후 별도 준비 폴더에 운영 의존성만 설치한다.
  Push-Location (Join-Path $repo 'server')
  try {
    Run $node @($npm,'ci','--no-audit','--no-fund')
    Run $node @($npm,'run','build')
    Run $node @($npm,'--prefix','../central','ci','--no-audit','--no-fund')
    Run $node @($npm,'--prefix','../central','run','build')
    foreach ($test in @('smoke','design-regression','tool-contract','safety-regression','delete-scenario','edit-scenario','reconnect-scenario','service-smoke','service-lifetime','memory-smoke','knowledge-smoke','usage-smoke','cli-missing-scenario','central-e2e')) {
      Run $node @("scripts/$test.mjs")
    }
  } finally { Pop-Location }
  Run dotnet @('run','--project',(Join-Path $repo 'tests/RuntimePaths.Smoke/RuntimePaths.Smoke.csproj'),'-c','Release')
  New-Item -ItemType Directory -Path (Join-Path $contents 'plugin'),(Join-Path $contents 'server'),(Join-Path $contents 'licenses') -Force | Out-Null
  $pluginOut = Join-Path $repo 'plugin/bin/Release/net8.0-windows'
  foreach ($name in @('MyCivil3DMcp.Plugin.dll','MyCivil3DMcp.Plugin.deps.json','MyCivil3DMcp.Plugin.runtimeconfig.json')) {
    Copy-Item -LiteralPath (Join-Path $pluginOut $name) -Destination (Join-Path $contents 'plugin')
  }
  Copy-Item -LiteralPath $runtime -Destination (Join-Path $contents 'node') -Recurse
  Copy-Item -LiteralPath (Join-Path $runtime 'LICENSE') -Destination (Join-Path $contents 'licenses/Node-LICENSE.txt')
  $server = Join-Path $contents 'server'
  foreach ($name in @('build','skills','knowledge-defaults','setup','package.json','package-lock.json')) {
    Copy-Item -LiteralPath (Join-Path $repo "server/$name") -Destination $server -Recurse
  }
  Push-Location $server
  try { Run $node @($npm,'ci','--omit=dev','--no-audit','--no-fund') } finally { Pop-Location }
  $package = Get-Content -LiteralPath (Join-Path $server 'package.json') -Raw | ConvertFrom-Json
  $source = (& git -C $repo rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0) { throw '소스 commit 확인 실패' }
  $status = @(& git -C $repo status --porcelain)
  $version = [ordered]@{ version=$package.version; nodeVersion=$config.version; nodeArchiveSha256=$config.sha256;
    builtAt=[DateTime]::UtcNow.ToString('o'); sourceCommit=$source; sourceDirty=($status.Count -gt 0); supportedCivil3D=@('2025'); claudeQuotaMode='statusline' }
  $version | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $contents 'version.json') -Encoding UTF8
  @"
<?xml version="1.0" encoding="utf-8"?>
<ApplicationPackage SchemaVersion="1.0" AppVersion="$($package.version)" Name="MyCivil3DMcp" Description="Civil 3D MCP palette" Author="MyCivil3DMcp" ProductCode="{$([guid]::NewGuid().ToString().ToUpperInvariant())}" UpgradeCode="{E49DD37D-13B7-4DA8-A616-85109188D819}">
  <Components>
    <RuntimeRequirements OS="Win64" Platform="Civil3D" SeriesMin="R25.0" SeriesMax="R25.0" />
    <ComponentEntry AppName="MyCivil3DMcp" AppDescription="Civil 3D AI palette" AppType=".Net" ModuleName="./Contents/plugin/MyCivil3DMcp.Plugin.dll" LoadOnAutoCADStartup="True" />
  </Components>
</ApplicationPackage>
"@ | Set-Content -LiteralPath (Join-Path $bundle 'PackageContents.xml') -Encoding UTF8
  foreach ($name in @('install.ps1','installer-ui.ps1','uninstall.ps1','package-common.ps1','설치.bat','삭제.bat','먼저읽어주세요.txt')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $release }
  Copy-Item -LiteralPath (Join-Path $repo 'docs/배포_설치.md') -Destination (Join-Path $release 'README-install.md')
  Write-BundleManifest $bundle
  [void](Test-Bundle $bundle)
  Run $node @((Join-Path $repo 'server/scripts/package-smoke.mjs'),$bundle)
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'package-regression.ps1') -Bundle $bundle
  if ($LASTEXITCODE -ne 0) { throw '설치·복구 검사 실패' }
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = Join-Path $work "MyCivil3DMcp-$($package.version)-win-x64.zip"
  [IO.Compression.ZipFile]::CreateFromDirectory($release,$zip,[IO.Compression.CompressionLevel]::Optimal,$false)
  # 모든 검사 후 결과를 공개한다. 이전 dist는 새 산출물 확인 전 삭제하지 않는다.
  $destination = Join-Path $dist 'MyCivil3DMcp.bundle'
  if (Test-Path -LiteralPath $destination) { Remove-OwnedDirectory $destination $dist }
  Copy-Item -LiteralPath $bundle -Destination $destination -Recurse
  foreach ($name in @('install.ps1','installer-ui.ps1','uninstall.ps1','package-common.ps1','설치.bat','삭제.bat','먼저읽어주세요.txt','README-install.md')) { Copy-Item -LiteralPath (Join-Path $release $name) -Destination $dist -Force }
  $finalZip = Join-Path $dist ([IO.Path]::GetFileName($zip))
  Copy-Item -LiteralPath $zip -Destination $finalZip -Force
  ((Get-FileHash -LiteralPath $finalZip -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + [IO.Path]::GetFileName($finalZip)) | Set-Content -LiteralPath ($finalZip + '.sha256') -Encoding ASCII
  Write-Host "패키지 생성 완료: $finalZip ($([Math]::Round((Get-Item -LiteralPath $finalZip).Length / 1MB,1)) MB)"
} finally { Remove-OwnedDirectory $work $workRoot }
