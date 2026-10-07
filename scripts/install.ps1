param(
  [string]$BundlePath = (Join-Path $PSScriptRoot 'MyCivil3DMcp.bundle'),
  [string]$Archive,
  [string]$DestinationRoot = (Join-Path $env:APPDATA 'Autodesk\ApplicationPlugins'),
  # server.json이 있으면 중앙 서버의 배포 버전을 확인해 더 새 것을 받아 설치한다(온라인 설치).
  [string]$ServerFile = (Join-Path $PSScriptRoot 'server.json'),
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'MyCivil3DMcp\data'),
  # 같은 버전이어도 다시 설치한다(설치 창의 [다시 설치]). 더 오래된 버전으로 내리는 것도 이때만 한다.
  [switch]$Reinstall,
  [switch]$SkipRunningCheck,  # 테스트용: 실행 중인 Civil 3D 확인을 건너뛴다(설치 대상이 임시 폴더일 때만)
  # 서명 확인용 공개 키(기본: 이 폴더의 release-public-key.xml). 테스트는 임시 키를 쓴다.
  [string]$TrustedKeyFile,
  # 개발용 빌드(서명 없음)를 설치할 때만. 설치 창은 이 옵션을 쓰지 않는다.
  [switch]$AllowUnsigned
)
. (Join-Path $PSScriptRoot 'package-common.ps1')
if (-not $TrustedKeyFile) { $TrustedKeyFile = Get-TrustedKeyFile }
$target = Join-Path $DestinationRoot 'MyCivil3DMcp.bundle'
Write-Host '실행 중인 프로그램을 확인하고 있습니다...'
if (-not $SkipRunningCheck) { Assert-BundleStopped $target }
Write-Host '설치를 진행할 수 있습니다. 파일 검증과 복사 중에는 창을 닫지 마세요.'
Remove-StaleInstallWork $DestinationRoot
$installed = Get-InstalledVersion $target

# 설치할 필요가 있는지. "[완료]"로 시작하는 줄은 설치 창이 "설치할 것 없음"으로 보여 준다.
function Test-NeedsInstall([string]$Version) {
  if (-not $installed -or -not $Version -or $Reinstall) { return $true }
  $order = Compare-ProductVersion $installed $Version
  if ($order -eq 0) { Write-Host "[완료] 이미 같은 버전($installed)이 설치되어 있습니다. 다시 설치하려면 [다시 설치]를 누르세요."; return $false }
  if ($order -gt 0) { Write-Host "[완료] 설치된 버전($installed)이 이 설치 파일($Version)보다 새롭습니다. 이전 버전으로 바꾸려면 [다시 설치]를 누르세요."; return $false }
  return $true
}

$unpack = $null
$download = $null
$server = $null
try {
  if (-not $Archive -and (Test-Path -LiteralPath $ServerFile)) {
    $server = Read-ServerSettings $ServerFile
    Write-Host '[1/4] 서버에서 최신 버전을 확인하고 있습니다...'
    $release = $null; $failure = $null
    try { $release = Get-ServerRelease $server } catch { $failure = $_.Exception.Message }
    if ($release) {
      # 받기 전에 판단한다(이미 최신이면 내려받지 않는다).
      if (-not (Test-NeedsInstall $release.version)) { return }
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
  # 어디서 온 번들이든 서명을 확인한다. 서명이 맞아야 manifest의 SHA-256 목록을 믿을 수 있다.
  if ($AllowUnsigned) { Write-Host '서명 확인을 건너뜁니다(개발용 빌드).' } else { Assert-BundleSignature $BundlePath $TrustedKeyFile }
  # 서버에서 받은 것은 서버가 알려 준 그 버전이어야 한다(서명된 옛 버전으로 되돌리는 공격을 막는다).
  if ($download -and (Get-InstalledVersion $BundlePath) -ne $release.version) { throw '받은 설치 파일의 버전이 서버 정보와 다릅니다. 설치하지 않습니다.' }
  # 폴더나 zip의 번들도 설치된 버전과 비교한다(서버에서 받은 것은 위에서 이미 비교했다).
  if (-not $download -and -not (Test-NeedsInstall (Get-InstalledVersion $BundlePath))) { return }
  $result = Invoke-BundleInstall $BundlePath $DestinationRoot
  Write-Host "설치했습니다: $($result.installed) ($(Get-InstalledVersion $result.installed))"
  if ($result.backup) { Write-Host "이전 버전 보관: $($result.backup)" }
  Remove-OldBackups $DestinationRoot $result.backup
  Write-Host 'Civil 3D 2025를 실행하세요. 처음 질문할 때 선택한 AI를 설치하고 로그인합니다.'
} finally {
  if ($server -and (Save-CentralJoin $server $DataDir)) { Write-Host '중앙 서버 연결은 Civil 3D를 켜면 자동으로 진행됩니다.' }
  if ($unpack) { Remove-OwnedDirectory $unpack $DestinationRoot }
  if ($download) { Remove-OwnedDirectory $download ([IO.Path]::GetTempPath()) }
}
