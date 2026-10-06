# My Civil 3D MCP - AI CLI 하나 설치·로그인
# 팔레트에서 설치 안 된 AI를 고르고 [설치]를, 로그인 안 된 AI에서 [로그인]을 누르면
# 그 AI 하나에 대해 이 스크립트가 새 창으로 열린다(server/src/ai/cliSetup.ts).
#   -Action install   CLI를 설치하고 이어서 로그인
#   -Action login     로그인만
#   -Action check     설치·로그인 상태만 출력(테스트용, 아무것도 바꾸지 않음)
# 로그인은 열리는 브라우저에서 사용자가 자기 계정으로 직접 한다. 비밀번호나 키는 이 스크립트가 다루지 않는다.
param(
  [Parameter(Mandatory = $true)][ValidateSet('claude', 'codex', 'gemini')][string]$Provider,
  [ValidateSet('install', 'login', 'check')][string]$Action = 'install'
)
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$Display = @{ claude = 'Claude'; codex = 'Codex'; gemini = 'Gemini' }[$Provider]
$Account = @{ claude = 'Claude(Anthropic) 계정'; codex = 'ChatGPT(OpenAI) 계정'; gemini = 'Google 계정' }[$Provider]
$Host.UI.RawUI.WindowTitle = "My Civil 3D MCP - ${Display} 설치·로그인"

# 이 창의 PATH를 레지스트리의 최신 값으로 맞춘다(Civil 3D가 켜진 뒤 설치한 것도 보이게).
function Update-Path {
  # MY_CIVIL3D_CLI_DIRS: only these folders (a fixed CLI folder, or a test PC without the CLIs).
  if ($env:MY_CIVIL3D_CLI_DIRS) { $env:Path = "$($env:MY_CIVIL3D_CLI_DIRS);$($env:SystemRoot)\System32"; return }
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $env:Path = (@($machine, $user, (Join-Path $env:USERPROFILE '.local\bin'), (Join-Path $env:APPDATA 'npm')) | Where-Object { $_ }) -join ';'
}

function Find-Cli {
  Update-Path
  $command = Get-Command $Provider -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { return $command.Source }
  return $null
}

function Install-Cli {
  if ($Provider -eq 'claude') {
    Write-Host '공식 설치 스크립트(https://claude.ai/install.ps1)로 설치합니다.'
    Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression
    return
  }
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host 'Node.js(npm)가 필요합니다. https://nodejs.org 에서 LTS를 설치한 뒤 다시 시도하세요.' -ForegroundColor Yellow
    return
  }
  $package = @{ codex = '@openai/codex'; gemini = '@google/gemini-cli' }[$Provider]
  Write-Host "npm으로 설치합니다($package)."
  & npm install -g $package
}

# 'yes' / 'no' / 'unknown'(Gemini: 상태를 묻는 명령이 없음)
function Get-Login([string]$cli) {
  switch ($Provider) {
    'claude' {
      $text = (& $cli auth status 2>$null) -join "`n"
      try { if (($text | ConvertFrom-Json).loggedIn) { return 'yes' } } catch { }
      return 'no'
    }
    'codex' {
      & $cli login status *> $null
      if ($LASTEXITCODE -eq 0) { return 'yes' } else { return 'no' }
    }
    default { return 'unknown' }
  }
}

function Start-Login([string]$cli) {
  Write-Host ''
  Write-Host "열리는 브라우저에서 ${Account}(으)로 로그인하세요."
  switch ($Provider) {
    'claude' { & $cli auth login }
    'codex' { & $cli login }
    'gemini' {
      Write-Host 'Gemini가 실행되면 로그인 방법(Google 계정)을 고르고, 로그인한 뒤 /quit 을 입력해 끝내세요.'
      & $cli
    }
  }
}

function Finish([string]$message, [string]$color = 'Green') {
  Write-Host ''
  Write-Host $message -ForegroundColor $color
  if ($Action -ne 'check') {
    Write-Host "이 창을 닫고 Civil 3D 팔레트에서 ${Display}를 다시 누르세요."
    Read-Host '엔터를 누르면 닫힙니다' | Out-Null
  }
  exit
}

$cli = Find-Cli
if ($Action -eq 'check') {
  if (-not $cli) { Finish "${Display} CLI: 설치 안 됨" 'Yellow' }
  Finish "${Display} CLI: $cli · 로그인 $(Get-Login $cli)"
}

if (-not $cli) {
  if ($Action -eq 'login') { Finish "${Display} CLI가 없어 로그인할 수 없습니다. 팔레트에서 다시 눌러 설치를 고르세요." 'Yellow' }
  Install-Cli
  $cli = Find-Cli
  if (-not $cli) { Finish '설치를 확인하지 못했습니다. 위의 메시지를 확인하세요.' 'Yellow' }
  Write-Host "설치했습니다: $cli" -ForegroundColor Green
}

if ((Get-Login $cli) -eq 'yes') { Finish "${Display}는 이미 로그인되어 있습니다." }
Start-Login $cli
switch (Get-Login $cli) {
  'yes' { Finish '로그인을 확인했습니다.' }
  'no' { Finish '로그인을 확인하지 못했습니다. 팔레트에서 다시 눌러 로그인을 시도하세요.' 'Yellow' }
  default { Finish '끝났습니다. 팔레트에서 확인합니다.' }
}
