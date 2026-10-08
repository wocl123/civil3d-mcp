# -NuGetAutodesk: Civil 3D가 없는 PC·CI에서 Autodesk 공식 참조 패키지(NuGet)로 플러그인을 빌드한다.
param([string]$AcadDir = 'C:\Program Files\Autodesk\AutoCAD 2025', [string]$NodeArchive, [switch]$NuGetAutodesk, [switch]$RequireSignature)
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
  $autodesk = if ($NuGetAutodesk) { '-p:AutodeskRefs=NuGet' } else { "-p:AcadDir=$AcadDir" }
  Run dotnet @('build',(Join-Path $repo 'plugin/MyCivil3DMcp.Plugin.csproj'),'-c','Release',$autodesk,'-clp:ErrorsOnly')
  # tsc는 개발 의존성이다. 빌드 후 별도 준비 폴더에 운영 의존성만 설치한다.
  Push-Location (Join-Path $repo 'server')
  try {
    Run $node @($npm,'ci','--no-audit','--no-fund')
    Run $node @($npm,'run','build')
    foreach ($test in @('smoke','design-regression','tool-contract','safety-regression','delete-scenario','edit-scenario','reconnect-scenario','service-smoke','service-lifetime','memory-smoke','knowledge-smoke','usage-smoke','cli-missing-scenario','drive-e2e')) {
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
  foreach ($name in @('install.ps1','installer-ui.ps1','uninstall.ps1','package-common.ps1','release-public-key.xml','설치.bat','삭제.bat','먼저읽어주세요.txt')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $release }
  Copy-Item -LiteralPath (Join-Path $repo 'docs/배포_설치.md') -Destination (Join-Path $release 'README-install.md')
  # 팀 정보: 관리자 메일(GitHub 저장소 Variables ADMIN_EMAIL). 비밀이 아니다. 이 zip으로 설치한 PC는
  # 구글 드라이브에 보내기 폴더를 만들고, 그 폴더를 이 메일과 공유하라고 안내한다(공유 = 가입 신청).
  if ($env:MY_CIVIL3D_ADMIN_EMAIL) {
    if ($env:MY_CIVIL3D_ADMIN_EMAIL -notmatch '^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$') { throw 'ADMIN_EMAIL 형식이 맞지 않습니다.' }
    [IO.File]::WriteAllText((Join-Path $release 'team.json'), ([pscustomobject]@{ adminEmail = $env:MY_CIVIL3D_ADMIN_EMAIL } | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
    Write-Host "관리자 메일을 넣었습니다: $($env:MY_CIVIL3D_ADMIN_EMAIL)"
  } else { Write-Host '알림: 관리자 메일(ADMIN_EMAIL)이 없어 team.json 없이 만듭니다(설치 후 /중앙 신청 <관리자 메일> 필요).' }
  # 자동 업데이트 도우미: 설치된 번들이 다음 버전을 설치할 때 쓰는 스크립트와 공개 키(서명 대상에 포함된다).
  $installer = Join-Path $contents 'installer'
  New-Item -ItemType Directory -Path $installer -Force | Out-Null
  foreach ($name in @('install.ps1','package-common.ps1','release-public-key.xml','update.ps1')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $installer }
  Write-BundleManifest $bundle
  # 서명: 비밀 키(MY_CIVIL3D_SIGNING_KEY 또는 _FILE)가 있으면 manifest에 서명한다. 없으면 개발용(설치 프로그램이 거절).
  $signing = [bool]($env:MY_CIVIL3D_SIGNING_KEY -or $env:MY_CIVIL3D_SIGNING_KEY_FILE)
  if ($RequireSignature -and -not $signing) { throw '서명 키가 없습니다. 릴리스 빌드는 서명해야 합니다(RELEASE_SIGNING_KEY).' }
  if ($signing) {
    Run $node @((Join-Path $PSScriptRoot 'release-signing.mjs'),'sign-manifest',$bundle)
    Assert-BundleSignature $bundle (Join-Path $PSScriptRoot 'release-public-key.xml')
  } else { Write-Host '경고: 서명하지 않은 개발용 빌드입니다. 설치 프로그램은 -AllowUnsigned 없이는 설치하지 않습니다.' }
  [void](Test-Bundle $bundle)
  Run $node @((Join-Path $repo 'server/scripts/package-smoke.mjs'),$bundle)
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'package-regression.ps1') -Bundle $bundle
  if ($LASTEXITCODE -ne 0) { throw '설치·복구 검사 실패' }
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  # 번들(파일 수천 개)은 zip 하나로 묶는다. 사용자는 설치 파일 몇 개만 풀고, 번들은 설치 프로그램이 .NET으로 빠르게 푼다.
  [IO.Compression.ZipFile]::CreateFromDirectory($bundle,(Join-Path $release 'MyCivil3DMcp.bundle.zip'),[IO.Compression.CompressionLevel]::Optimal,$true)
  Remove-Item -LiteralPath $bundle -Recurse -Force
  $zip = Join-Path $work "MyCivil3DMcp-$($package.version)-win-x64.zip"
  # 안의 번들 zip은 이미 압축되어 있으므로 바깥은 압축하지 않는다(만들기·풀기 모두 빠르다).
  [IO.Compression.ZipFile]::CreateFromDirectory($release,$zip,[IO.Compression.CompressionLevel]::NoCompression,$false)
  # 만든 zip으로 설치(zip을 그대로 푼 폴더 → 설치, 서명·버전 확인)와 드라이브 자동 업데이트를 끝까지 확인한다.
  Run $node @((Join-Path $repo 'server/scripts/release-install.mjs'),$zip)
  # 모든 검사 후 결과를 공개한다. 이전 dist는 새 산출물 확인 전 삭제하지 않는다.
  # dist에는 전달할 zip과 해시만 둔다. 번들과 설치 파일은 zip 안에 있다(예전 빌드가 풀어 둔 사본은 지운다).
  $destination = Join-Path $dist 'MyCivil3DMcp.bundle'
  if (Test-Path -LiteralPath $destination) { Remove-OwnedDirectory $destination $dist }
  foreach ($name in @('install.ps1','installer-ui.ps1','uninstall.ps1','package-common.ps1','설치.bat','삭제.bat','먼저읽어주세요.txt','README-install.md')) {
    $loose = Join-Path $dist $name
    if (Test-Path -LiteralPath $loose -PathType Leaf) { Remove-Item -LiteralPath $loose -Force }
  }
  $finalZip = Join-Path $dist ([IO.Path]::GetFileName($zip))
  Copy-Item -LiteralPath $zip -Destination $finalZip -Force
  ((Get-FileHash -LiteralPath $finalZip -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + [IO.Path]::GetFileName($finalZip)) | Set-Content -LiteralPath ($finalZip + '.sha256') -Encoding ASCII
  # zip 전체 서명(.sig): 중앙 서버가 받을 때 확인한다.
  if ($signing) { Run $node @((Join-Path $PSScriptRoot 'release-signing.mjs'),'sign-file',$finalZip) }
  Write-Host "패키지 생성 완료: $finalZip ($([Math]::Round((Get-Item -LiteralPath $finalZip).Length / 1MB,1)) MB)"
} finally { Remove-OwnedDirectory $work $workRoot }
