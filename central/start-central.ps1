# my-civil3d-mcp 중앙 서버 시작 (docs\중앙서버_설정_가이드.md)
#   .\start-central.ps1                 이 PC에서만 (설정 파일 그대로)
#   .\start-central.ps1 -AllowNetwork   다른 PC도 접속 (host 0.0.0.0, HTTPS 인증서, 방화벽 규칙)
#   .\start-central.ps1 -Port 49000     포트 바꾸기
#   -RemoteAddress 10.0.0.0/8           방화벽에서 접속을 허용할 범위(기본: 같은 서브넷만 LocalSubnet)
# 다른 PC가 접속하는 설정이면:
#   - HTTPS 인증서를 만든다(<dataDir>\tls, 처음 한 번). 클라이언트는 이 인증서 지문만 믿는다.
#   - 데이터 폴더(키·토큰·기록)를 이 사용자, SYSTEM, 관리자만 읽게 한다.
#   - 관리자 권한이면 방화벽 규칙을 만든다(허용 범위를 좁혀서, 공용 네트워크에서도 적용).
param([switch]$AllowNetwork, [int]$Port = 0, [string]$RemoteAddress = 'LocalSubnet')
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Host 'Node.js가 없습니다. https://nodejs.org 에서 20 이상(LTS)을 설치한 뒤 다시 실행하세요.'; exit 1 }
$major = [int]((& node --version).TrimStart('v').Split('.')[0])
if ($major -lt 20) { Write-Host "Node.js $(& node --version)는 너무 오래됐습니다. 20 이상을 설치하세요."; exit 1 }

if (-not (Test-Path node_modules)) { Write-Host '처음 실행: 필요한 도구를 설치합니다...'; & npm install --no-audit --no-fund; if ($LASTEXITCODE) { exit 1 } }
& npm run build --silent
if ($LASTEXITCODE) { Write-Host '빌드에 실패했습니다.'; exit 1 }

# settings.json: 없으면 기본값으로 만들고, 옵션으로 받은 값만 바꾼다.
$settingsFile = Join-Path $PSScriptRoot 'settings.json'
if (Test-Path $settingsFile) { $settings = Get-Content $settingsFile -Raw -Encoding UTF8 | ConvertFrom-Json }
else { $settings = [pscustomobject]@{ host = '127.0.0.1'; port = 48950; dataDir = 'data' } }
if ($AllowNetwork) { $settings.host = '0.0.0.0' }
if ($Port -gt 0) { $settings.port = $Port }
$json = $settings | ConvertTo-Json
[System.IO.File]::WriteAllText($settingsFile, $json, (New-Object System.Text.UTF8Encoding $false))

$dataDir = if ([IO.Path]::IsPathRooted($settings.dataDir)) { $settings.dataDir } else { Join-Path $PSScriptRoot $settings.dataDir }
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
# 키(config.json), 인증서 비밀 키, 토큰 해시, 기록: 이 사용자·SYSTEM·관리자만
& icacls $dataDir /inheritance:r /grant:r "${env:USERDOMAIN}\${env:USERNAME}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE) { Write-Host '데이터 폴더 권한을 좁히지 못했습니다. 폴더 위치를 확인하세요.' }

if ($settings.host -ne '127.0.0.1' -and $settings.host -ne 'localhost') {
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'new-cert.ps1') -DataDir $dataDir
  if ($LASTEXITCODE) { Write-Host 'HTTPS 인증서를 만들지 못했습니다.'; exit 1 }

  $rule = "my-civil3d-mcp central $($settings.port)"
  $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  $exists = Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue
  if ($admin) {
    # 허용 범위를 좁히고(기본 같은 서브넷) 네트워크 종류와 상관없이 적용한다. 이미 있으면 범위를 맞춘다.
    if ($exists) { Set-NetFirewallRule -DisplayName $rule -Profile Any -RemoteAddress $RemoteAddress -Action Allow }
    else { New-NetFirewallRule -DisplayName $rule -Direction Inbound -Protocol TCP -LocalPort $settings.port -Action Allow -Profile Any -RemoteAddress $RemoteAddress | Out-Null }
    Write-Host "방화벽: 포트 $($settings.port)를 $RemoteAddress 에서만 받습니다."
  } elseif (-not $exists) {
    Write-Host "다른 PC가 접속하려면 방화벽 규칙이 필요합니다. 이 스크립트를 '관리자 권한으로 실행'하면 같은 서브넷만 허용하는 규칙을 만듭니다."
  }
}

Write-Host '서버를 시작합니다. 끄려면 이 창에서 Ctrl+C.'
& node build/server.js
