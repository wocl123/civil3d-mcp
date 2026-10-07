# 자동 업데이트 도우미 (서비스가 띄운다. server/src/update/autoUpdate.ts).
# 이 Civil 3D(WaitPid)가 꺼질 때까지 기다렸다가, 받아 둔 zip을 install.ps1로 설치한다.
# install.ps1이 서명·버전을 확인하므로 공식 배포본이 아니면 설치되지 않는다.
# 기록: <DataDir>\logs\<날짜>\update.log. 실패하면 받아 둔 파일을 남겨 두고, 다음에 Civil 3D를 켤 때 다시 예약된다.
param(
  [Parameter(Mandatory = $true)][string]$Archive,
  [Parameter(Mandatory = $true)][int]$WaitPid,
  [Parameter(Mandatory = $true)][string]$DataDir,
  [string]$Version,
  [string]$DestinationRoot,
  [switch]$SkipRunningCheck   # 테스트용(설치 대상이 임시 폴더일 때만)
)
$ErrorActionPreference = 'Stop'
function Write-Log([string]$Text) {
  try {
    $folder = Join-Path $DataDir ('logs\' + (Get-Date -Format 'yyyy-MM-dd'))
    New-Item -ItemType Directory -Path $folder -Force | Out-Null
    Add-Content -LiteralPath (Join-Path $folder 'update.log') -Value ("{0:HH:mm:ss} {1}" -f (Get-Date), $Text) -Encoding UTF8
  } catch { }
}

# 같은 업데이트 도우미가 이미 기다리고 있으면(Civil 3D를 여러 개 켠 경우) 하나만 진행한다.
$mutex = New-Object Threading.Mutex($false, 'Local\MyCivil3DMcpUpdate')
if (-not $mutex.WaitOne(0)) { Write-Log "다른 업데이트 도우미가 진행 중이라 끝냅니다($Version)."; exit 0 }
try {
  Write-Log "업데이트 $Version 예약: Civil 3D(pid $WaitPid)가 꺼지기를 기다립니다."
  Wait-Process -Id $WaitPid -ErrorAction SilentlyContinue
  # Civil 3D가 끈 서비스(번들의 node.exe)가 내려갈 시간을 준다. 그동안 Civil 3D를 다시 켜면 다음 기회로 미룬다.
  Start-Sleep -Seconds 8
  if (-not $SkipRunningCheck -and (Get-Process -Name acad -ErrorAction SilentlyContinue)) { Write-Log 'Civil 3D가 다시 켜져 있어 이번에는 설치하지 않습니다(다음에 다시 예약됨).'; exit 0 }
  $arguments = @{ Archive = $Archive; DataDir = $DataDir }
  if ($DestinationRoot) { $arguments.DestinationRoot = $DestinationRoot }
  if ($SkipRunningCheck) { $arguments.SkipRunningCheck = $true }
  $output = & (Join-Path $PSScriptRoot 'install.ps1') @arguments 6>&1 2>&1 | ForEach-Object { "$_" }
  $output | ForEach-Object { Write-Log "  $_" }
  Write-Log "업데이트 $Version 완료."
  Remove-Item -LiteralPath $Archive -Force -ErrorAction SilentlyContinue
} catch {
  Write-Log "업데이트 $Version 실패: $($_.Exception.Message)"
  exit 1
} finally {
  $mutex.ReleaseMutex(); $mutex.Dispose()
}
