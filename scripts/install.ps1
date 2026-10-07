param(
  [string]$BundlePath = (Join-Path $PSScriptRoot 'MyCivil3DMcp.bundle'),
  [string]$Archive,
  [string]$DestinationRoot = (Join-Path $env:APPDATA 'Autodesk\ApplicationPlugins')
)
. (Join-Path $PSScriptRoot 'package-common.ps1')
$target = Join-Path $DestinationRoot 'MyCivil3DMcp.bundle'
Write-Host '실행 중인 프로그램을 확인하고 있습니다...'
Assert-BundleStopped $target
Write-Host '설치를 진행할 수 있습니다. 파일 검증과 복사 중에는 창을 닫지 마세요.'
$unpack = $null
try {
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
  Write-Host 'Civil 3D 2025를 실행하세요. 처음 질문할 때 선택한 AI를 설치하고 로그인합니다.'
} finally { if ($unpack) { Remove-OwnedDirectory $unpack $DestinationRoot } }
