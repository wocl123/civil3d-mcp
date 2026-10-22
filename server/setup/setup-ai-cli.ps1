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

# 동봉 Node·npm의 절대 경로를 쓰고, CLI는 쓰기 가능한 사용자 폴더에 둔다.
$runtimeDir = if ($env:MY_CIVIL3D_NODE_EXE) { Split-Path -Parent $env:MY_CIVIL3D_NODE_EXE } else { $null }
$cliRoot = if ($env:MY_CIVIL3D_CLI_ROOT) { $env:MY_CIVIL3D_CLI_ROOT } else { Join-Path $env:LOCALAPPDATA 'MyCivil3DMcp\cli' }
$cliPrefix = if ($env:MY_CIVIL3D_CLI_PREFIX) { $env:MY_CIVIL3D_CLI_PREFIX } else { Join-Path $cliRoot $Provider }
$Display = @{ claude = 'Claude'; codex = 'Codex'; gemini = 'Gemini' }[$Provider]
$Account = @{ claude = 'Claude(Anthropic) 계정'; codex = 'ChatGPT(OpenAI) 계정'; gemini = 'Google 계정' }[$Provider]
$cliCommand = if ($Provider -eq 'gemini') { 'agy' } else { $Provider }
$Host.UI.RawUI.WindowTitle = "My Civil 3D MCP - ${Display} 설치·로그인"

# 실행 요청만으로 성공 처리하지 않는다. 새 창의 입력·출력 준비를 서비스에 알린다.
if ($env:MY_CIVIL3D_SETUP_STATUS) {
  $interactive = -not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected
  $status = @{ ready = $interactive; pid = $PID }
  if (-not $interactive) { $status.message = '입력 가능한 콘솔 창을 만들지 못했습니다.' }
  $status | ConvertTo-Json -Compress | Set-Content -LiteralPath $env:MY_CIVIL3D_SETUP_STATUS -Encoding UTF8
  if (-not $interactive) { exit 1 }
}

# 이 창의 PATH를 레지스트리의 최신 값으로 맞춘다(Civil 3D가 켜진 뒤 설치한 것도 보이게).
function Update-Path {
  # MY_CIVIL3D_CLI_DIRS: only these folders (a fixed CLI folder, or a test PC without the CLIs).
  if ($env:MY_CIVIL3D_CLI_DIRS) {
    $dirs = @($cliPrefix, $env:MY_CIVIL3D_CLI_DIRS, "$($env:SystemRoot)\System32")
    if ($env:MY_CIVIL3D_NODE_EXE) { $dirs = @($runtimeDir, $cliPrefix) + $dirs }
    $env:Path = ($dirs | Where-Object { $_ }) -join ';'
    return
  }
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $env:Path = (@($runtimeDir, $cliPrefix, $machine, $user, (Join-Path $env:LOCALAPPDATA 'agy\bin'), (Join-Path $env:USERPROFILE '.local\bin'), (Join-Path $env:APPDATA 'npm')) | Where-Object { $_ }) -join ';'
}

function Find-Cli {
  Update-Path
  $command = Get-Command $cliCommand -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { return $command.Source }
  return $null
}

function Install-Cli {
  if ($Provider -eq 'gemini') {
    Write-Host 'Gemini 개인 계정은 Antigravity CLI(agy)로 연결합니다. Node.js나 npm은 필요하지 않습니다.'
    # 격리된 설치 시험은 네트워크 대신 지정한 폴더의 설치 도우미를 쓴다.
    if ($env:MY_CIVIL3D_CLI_DIRS) {
      $installer = Get-Command 'install-agy.cmd' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
      if (-not $installer) { Finish 'Antigravity CLI 설치 도우미가 없습니다. 지정한 CLI 폴더를 확인하세요.' 'Yellow' }
      & $installer.Source $cliPrefix
      if ($LASTEXITCODE -ne 0) { Finish 'CLI 설치에 실패했습니다. 위의 오류와 네트워크 연결을 확인하세요.' 'Yellow' }
    } else {
      Write-Host '공식 설치 스크립트(https://antigravity.google/cli/install.ps1)로 설치합니다.'
      $installer = Join-Path ([IO.Path]::GetTempPath()) ('mycivil3d-agy-' + [guid]::NewGuid().ToString('N') + '.ps1')
      try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -UseBasicParsing -Uri 'https://antigravity.google/cli/install.ps1' -OutFile $installer -ErrorAction Stop
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer --dir $cliPrefix --skip-path --skip-aliases
        if ($LASTEXITCODE -ne 0) { Finish 'CLI 설치에 실패했습니다. 위의 오류와 네트워크 연결을 확인하세요.' 'Yellow' }
      } finally { Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue }
    }
    return
  }
  if ($Provider -eq 'claude') {
    Write-Host '공식 설치 스크립트(https://claude.ai/install.ps1)로 설치합니다.'
    Invoke-RestMethod https://claude.ai/install.ps1 -ErrorAction Stop | Invoke-Expression
    return
  }
  # 개발·격리 테스트에서는 기존 PATH npm을 쓴다. 배포에서는 동봉 npm을 우선한다.
  $npmFile = if ($runtimeDir -and (Test-Path -LiteralPath (Join-Path $runtimeDir 'npm.cmd'))) { Join-Path $runtimeDir 'npm.cmd' } else { (Get-Command npm -ErrorAction SilentlyContinue | Select-Object -First 1).Source }
  if (-not $npmFile) {
    Write-Host 'Node.js(npm)가 필요합니다. https://nodejs.org 에서 LTS를 설치한 뒤 다시 시도하세요.' -ForegroundColor Yellow
    return
  }
  $package = '@openai/codex'
  Write-Host "npm으로 설치합니다($package)."
  $installArgs = @('install', '-g', $package)
  if ($env:MY_CIVIL3D_NODE_EXE) {
    New-Item -ItemType Directory -Force -Path $cliPrefix | Out-Null
    $installArgs += @('--prefix', $cliPrefix)
    $env:npm_config_cache = Join-Path $cliRoot '.npm-cache'
  }
  & $npmFile @installArgs
  if ($LASTEXITCODE -ne 0) { Finish 'CLI 설치에 실패했습니다. 위의 오류와 네트워크 연결을 확인하세요.' 'Yellow' }
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
      Write-Host 'Antigravity CLI가 열립니다. Google 계정으로 로그인하고, 완료한 뒤 /quit 을 입력해 끝내세요.'
      & $cli
    }
  }
}

function Finish([string]$message, [string]$color = 'Green') {
  Write-Host ''
  Write-Host $message -ForegroundColor $color
  if ($Action -ne 'check') {
    Write-Host "이 창을 닫고 Civil 3D 팔레트의 새로고침(↻)을 눌러 ${Display} 연결을 확인하세요."
    Read-Host '엔터를 누르면 닫힙니다' | Out-Null
  }
  exit
}

trap {
  Finish ('설치·로그인 중 오류가 발생했습니다: ' + $_.Exception.Message) 'Yellow'
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
if ($LASTEXITCODE -ne 0) { Finish '로그인 프로그램이 오류로 종료됐습니다. 위의 오류를 확인한 뒤 다시 시도하세요.' 'Yellow' }
switch (Get-Login $cli) {
  'yes' { Finish '로그인을 확인했습니다.' }
  'no' { Finish '로그인을 확인하지 못했습니다. 팔레트에서 다시 눌러 로그인을 시도하세요.' 'Yellow' }
  default { Finish '끝났습니다. 팔레트에서 확인합니다.' }
}
