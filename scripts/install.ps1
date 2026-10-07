param(
  [string]$BundlePath = (Join-Path $PSScriptRoot 'MyCivil3DMcp.bundle'),
  [string]$Archive,
  [string]$DestinationRoot = (Join-Path $env:APPDATA 'Autodesk\ApplicationPlugins'),
  # server.json이 있으면 중앙 서버의 배포 버전을 확인해 더 새 것을 받아 설치한다(온라인 설치).
  [string]$ServerFile = (Join-Path $PSScriptRoot 'server.json'),
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'MyCivil3DMcp\data'),
  [switch]$Reinstall,
  [switch]$SkipRunningCheck   # 테스트용: 실행 중인 Civil 3D 확인을 건너뛴다(설치 대상이 임시 폴더일 때만)
)
. (Join-Path $PSScriptRoot 'package-common.ps1')
$target = Join-Path $DestinationRoot 'MyCivil3DMcp.bundle'
Write-Host '실행 중인 프로그램을 확인하고 있습니다...'
if (-not $SkipRunningCheck) { Assert-BundleStopped $target }
Write-Host '설치를 진행할 수 있습니다. 파일 검증과 복사 중에는 창을 닫지 마세요.'
$unpack = $null
$download = $null
try {
  $server = $null
  if (-not $Archive -and (Test-Path -LiteralPath $ServerFile)) {
    $server = Read-ServerSettings $ServerFile
    Write-Host '[1/4] 서버에서 최신 버전을 확인하고 있습니다...'
    $release = $null; $failure = $null
    try { $release = Get-ServerRelease $server } catch { $failure = $_.Exception.Message }
    $installed = Get-InstalledVersion $target
    if ($release) {
      if ($installed -and -not $Reinstall -and (Compare-ProductVersion $installed $release.version) -ge 0) {
        # 같거나 더 새 버전(개발용)이 있으면 내려 설치하지 않는다.
        Write-Host "[4/4] 이미 최신 버전입니다($installed). 설치할 것이 없습니다."
        if (Save-CentralJoin $server $DataDir) { Write-Host '중앙 서버 연결은 Civil 3D를 켜면 자동으로 진행됩니다.' }
        return
      }
      Write-Host "[1/4] 최신 버전 $($release.version)을 받고 있습니다$(if ($installed) { " (지금 $installed)" })..."
      $download = Join-Path ([IO.Path]::GetTempPath()) ('mycivil3d-download-' + [guid]::NewGuid().ToString('N'))
      New-Item -ItemType Directory -Path $download | Out-Null
      $Archive = Save-ServerRelease $server $release $download
    } elseif (Test-Path -LiteralPath (Join-Path $BundlePath 'Contents/manifest.json')) {
      # 서버에 연결하지 못했거나 배포 중인 버전이 없으면, 이 폴더의 설치 파일로 설치한다.
      Write-Host "서버에서 받지 못해 이 폴더의 설치 파일로 설치합니다. ($(if ($failure) { $failure } else { '배포 중인 버전 없음' }))"
    } else {
      throw "서버에서 설치 파일을 받지 못했습니다. $(if ($failure) { "($failure) " })네트워크와 server.json의 주소를 확인하세요."
    }
  }
  if ($Archive) {
    New-Item -ItemType Directory -Path $DestinationRoot -Force | Out-Null
    Assert-NoReparse $DestinationRoot
    $unpack = Assert-Within (Join-Path $DestinationRoot ('.mycivil3d-unpack-' + [guid]::NewGuid().ToString('N'))) $DestinationRoot
    Expand-SafeArchive $Archive $unpack
    $BundlePath = Join-Path $unpack 'MyCivil3DMcp.bundle'
  }
  $result = Invoke-BundleInstall $BundlePath $DestinationRoot
  Write-Host "설치했습니다: $($result.installed)"
  if ($result.backup) { Write-Host "이전 버전 보관: $($result.backup)" }
  if ($server -and (Save-CentralJoin $server $DataDir)) { Write-Host '중앙 서버 연결은 Civil 3D를 켜면 자동으로 진행됩니다.' }
  Write-Host 'Civil 3D 2025를 실행하세요. 처음 질문할 때 선택한 AI를 설치하고 로그인합니다.'
} finally {
  if ($unpack) { Remove-OwnedDirectory $unpack $DestinationRoot }
  if ($download) { Remove-OwnedDirectory $download ([IO.Path]::GetTempPath()) }
}
