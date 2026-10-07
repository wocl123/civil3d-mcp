param(
  [string]$DestinationRoot = (Join-Path $env:APPDATA 'Autodesk\ApplicationPlugins'),
  [switch]$RemoveUserData
)
. (Join-Path $PSScriptRoot 'package-common.ps1')
$target = Assert-Within (Join-Path $DestinationRoot 'MyCivil3DMcp.bundle') $DestinationRoot
Write-Host '[1/3] 실행 중인 프로그램을 확인하고 있습니다...'
Assert-BundleStopped $target
# 삭제 창은 단계 메시지를 표시한다. 사용자 데이터 삭제는 기존 명시 옵션으로만 수행한다.
Write-Host '[2/3] My Civil 3D MCP를 삭제하고 있습니다...'
Remove-OwnedDirectory $target $DestinationRoot
Write-Host '[3/3] 프로그램을 삭제했습니다. 사용자 데이터는 유지됩니다.'
if ($RemoveUserData) {
  # 사용자 데이터는 별도 명시 옵션과 확인 답변을 받은 경우에만 삭제한다.
  $root = [IO.Path]::GetFullPath($env:LOCALAPPDATA)
  $data = Assert-Within (Join-Path $root 'MyCivil3DMcp') $root
  if ((Read-Host "사용자 데이터와 앱 전용 CLI를 삭제할까요? $data (DELETE 입력)") -ceq 'DELETE') {
    Remove-OwnedDirectory $data $root
    Write-Host '앱 전용 사용자 데이터를 제거했습니다. AI 계정의 기존 로그인 설정은 유지됩니다.'
  }
}
