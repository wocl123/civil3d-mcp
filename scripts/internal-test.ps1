param([switch]$ConfirmManualPass)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$state = Join-Path $PSScriptRoot 'internal-test-state.mjs'
function Run([string]$Tool, [string[]]$Arguments) {
  & $Tool @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Tool 실패: 종료 코드 $LASTEXITCODE" }
}
if ($ConfirmManualPass) {
  Run node @($state, 'approve')
  return
}
if (Get-Process -Name acad -ErrorAction SilentlyContinue) {
  throw '기존 DLL 잠금·중복 로드를 피하려면 Civil 3D/AutoCAD를 종료한 뒤 내부 테스트 빌드를 실행하세요.'
}
Run node @($state, 'begin')
Run node @((Join-Path $repo 'server/scripts/internal-launcher.mjs'))
$variables = @('MY_CIVIL3D_DATA_DIR', 'MY_CIVIL3D_CONNECTION_DIR', 'MY_CIVIL3D_SERVER_ENTRY', 'MY_CIVIL3D_SYNC', 'MY_CIVIL3D_AUTO_UPDATE')
$previous = @{}
$testRoot = Join-Path $repo '.package-cache/internal-test'
New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
try {
  foreach ($name in $variables) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
  $env:MY_CIVIL3D_DATA_DIR = Join-Path $testRoot 'data'
  $env:MY_CIVIL3D_CONNECTION_DIR = Join-Path $testRoot 'connections'
  $env:MY_CIVIL3D_SERVER_ENTRY = Join-Path $repo 'server/build/localService.js'
  $env:MY_CIVIL3D_SYNC = 'off'
  $env:MY_CIVIL3D_AUTO_UPDATE = 'off'
  Run dotnet @('build', (Join-Path $repo 'plugin/MyCivil3DMcp.Plugin.csproj'), '-c', 'Release', '-clp:ErrorsOnly')
  Push-Location (Join-Path $repo 'server')
  try {
    Run npm @('run', 'build')
    Run npm @('run', 'lint')
    Run node @((Join-Path $repo 'scripts/build-ingest.mjs'))
    foreach ($test in @('smoke','design-regression','tool-contract','safety-regression','delete-scenario','edit-scenario',
      'layer-scenario','layer-state-scenario','civil-scenario','primitive-scenario','performance-scenario',
      'admin-menu','admin-cleanup','admin-worker','admin-terminal','admin-launcher','reconnect-scenario',
      'service-smoke','service-lifetime','memory-smoke','knowledge-smoke','usage-smoke','ai-failure','cli-missing-scenario','setup-window','internal-test-gate',
      'drive-e2e','drive-release','drive-folder','github-release','ingest-e2e','ingest-install')) {
      Run node @("scripts/$test.mjs")
    }
  } finally { Pop-Location }
  foreach ($test in @('RuntimePaths.Smoke','QuotaFooter.Preview','ProviderSetup.Smoke','ProfileLayout.Smoke')) {
    Run dotnet @('run', '--project', (Join-Path $repo "tests/$test/$test.csproj"), '-c', 'Release')
  }
  Run dotnet @('build', (Join-Path $repo 'tests/CivilCrud.Native/CivilCrud.Native.csproj'), '-c', 'Release', '-clp:ErrorsOnly')
  Run node @((Join-Path $repo 'server/scripts/plugin-load.mjs'))
  Run node @((Join-Path $repo 'server/scripts/native-civil.mjs'))
  Run node @((Join-Path $repo 'server/scripts/native-civil.mjs'), '--persisted')
  Run node @((Join-Path $repo 'server/scripts/native-civil.mjs'), '--networks')
  # SCRIPT 명령으로 실행하면 개발 DLL과 개발 서버를 연결한다. 설치본은 변경하지 않는다.
  $lines = @('(setvar "FILEDIA" 0)')
  if ($repo.Contains('"')) { throw '내부 테스트 경로에 따옴표를 사용할 수 없습니다.' }
  $lines += '(setenv "MY_CIVIL3D_LOAD_TEST_DIR" "' + $testRoot.Replace('\', '/') + '")'
  $dll = (Join-Path $repo 'plugin/bin/Release/net8.0-windows/MyCivil3DMcp.Plugin.dll').Replace('\', '/')
  $harness = (Join-Path $repo 'tests/CivilCrud.Native/bin/Release/net8.0-windows/CivilCrud.Native.dll').Replace('\', '/')
  $lines += '(setenv "MY_CIVIL3D_TEST_PLUGIN" "' + $dll + '")'
  $lines += @('_.NETLOAD', ('"' + $harness + '"'), 'MYC3DDEVLOAD', '(setvar "FILEDIA" 1)', '')
  [IO.File]::WriteAllText((Join-Path $testRoot 'load.scr'), ($lines -join "`r`n"), [Text.UTF8Encoding]::new($false))
  Run node @($state, 'pass')
  Write-Host "`n개발 DLL: $dll"
  Write-Host "Civil 3D의 SCRIPT 명령에서 실행: $(Join-Path $testRoot 'load.scr')"
  Write-Host '설치본이 자동 로드되는 경우 전용 테스트 프로필에서 자동 로드를 해제하고 재시작하세요. 이미 로드된 DLL은 교체할 수 없습니다.'
  Write-Host '수동 기능 확인 후: 내부테스트.bat -ConfirmManualPass'
  Write-Host '이번 실행은 배포 버전 변경·패키징·게시를 하지 않았습니다.'
} finally {
  foreach ($name in $variables) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
}
