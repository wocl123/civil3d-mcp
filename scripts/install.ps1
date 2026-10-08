param(
  [string]$BundlePath = (Join-Path $PSScriptRoot 'MyCivil3DMcp.bundle'),
  [string]$Archive,
  [string]$DestinationRoot = (Join-Path $env:APPDATA 'Autodesk\ApplicationPlugins'),
  # team.json(관리자 메일)이 있으면 데이터 폴더로 복사한다. 서비스가 구글 드라이브 보내기 폴더 안내에 쓴다.
  [string]$TeamFile = (Join-Path $PSScriptRoot 'team.json'),
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
# 배포 zip은 번들을 zip 하나(MyCivil3DMcp.bundle.zip)로 담는다. 파일 수천 개를 탐색기로 푸는 대신 여기서 한 번에 푼다.
$payload = Join-Path $PSScriptRoot 'MyCivil3DMcp.bundle.zip'
$hasBundleFolder = Test-Path -LiteralPath (Join-Path $BundlePath 'Contents/manifest.json')
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
try {
  if (-not $Archive -and -not $hasBundleFolder) {
    if (-not (Test-Path -LiteralPath $payload)) { throw '이 폴더에 설치 파일(MyCivil3DMcp.bundle.zip)이 없습니다. ZIP 전체를 새 폴더에 압축 해제해 주세요.' }
    $Archive = $payload
  }
  if ($Archive) {
    Write-Host '[1/4] 설치 파일의 압축을 풀고 있습니다...'
    New-Item -ItemType Directory -Path $DestinationRoot -Force | Out-Null
    Assert-NoReparse $DestinationRoot
    $unpack = Assert-Within (Join-Path $DestinationRoot ('.mycivil3d-unpack-' + [guid]::NewGuid().ToString('N'))) $DestinationRoot
    Expand-SafeArchive $Archive $unpack
    $BundlePath = Join-Path $unpack 'MyCivil3DMcp.bundle'
    # 배포 zip(설치 파일 + MyCivil3DMcp.bundle.zip)이면 안의 번들 zip을 한 번 더 푼다. 예전 형식(번들 폴더)도 그대로 받는다.
    $inner = Join-Path $unpack 'MyCivil3DMcp.bundle.zip'
    if (-not (Test-Path -LiteralPath $BundlePath) -and (Test-Path -LiteralPath $inner)) {
      $payloadDir = Join-Path $unpack 'payload'
      Expand-SafeArchive $inner $payloadDir
      $BundlePath = Join-Path $payloadDir 'MyCivil3DMcp.bundle'
    }
  }
  # 어디서 온 번들이든 서명을 확인한다. 서명이 맞아야 manifest의 SHA-256 목록을 믿을 수 있다.
  if ($AllowUnsigned) { Write-Host '서명 확인을 건너뜁니다(개발용 빌드).' } else { Assert-BundleSignature $BundlePath $TrustedKeyFile }
  # 설치된 버전과 비교한다(같거나 더 새 버전이 있으면 [다시 설치]일 때만).
  if (-not (Test-NeedsInstall (Get-InstalledVersion $BundlePath))) { return }
  $result = Invoke-BundleInstall $BundlePath $DestinationRoot
  Write-Host "설치했습니다: $($result.installed) ($(Get-InstalledVersion $result.installed))"
  if ($result.backup) { Write-Host "이전 버전 보관: $($result.backup)" }
  Remove-OldBackups $DestinationRoot $result.backup
  Write-Host 'Civil 3D 2025를 실행하세요. 처음 질문할 때 선택한 AI를 설치하고 로그인합니다.'
} finally {
  if (-not $Archive -or $Archive -eq $payload) { Save-TeamInfo $TeamFile $DataDir }
  if ($unpack) { Remove-OwnedDirectory $unpack $DestinationRoot }
}
