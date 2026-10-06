# my-civil3d-mcp 중앙 서버 시작 (docs\중앙서버_설정_가이드.md)
#   .\start-central.ps1                 이 PC에서만 (설정 파일 그대로)
#   .\start-central.ps1 -AllowNetwork   다른 PC도 접속 (host 0.0.0.0, 방화벽 규칙)
#   .\start-central.ps1 -Port 49000     포트 바꾸기
param([switch]$AllowNetwork, [int]$Port = 0)
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

if ($settings.host -eq '0.0.0.0') {
  $rule = "my-civil3d-mcp central $($settings.port)"
  $exists = Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue
  if (-not $exists) {
    $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if ($admin) {
      New-NetFirewallRule -DisplayName $rule -Direction Inbound -Protocol TCP -LocalPort $settings.port -Action Allow -Profile Private,Domain | Out-Null
      Write-Host "방화벽에 포트 $($settings.port)를 열었습니다(개인·도메인 네트워크만)."
    } else {
      Write-Host "다른 PC가 접속하려면 방화벽에서 포트 $($settings.port)를 열어야 합니다. 이 스크립트를 '관리자 권한으로 실행'하면 자동으로 엽니다."
    }
  }
}

Write-Host '서버를 시작합니다. 끄려면 이 창에서 Ctrl+C.'
& node build/server.js
