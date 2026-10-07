# 새 버전 내기 (운영_매뉴얼 2장). 새버전내기.bat 이 실행한다.
#   1) 확인: Git·npm 있음, main 브랜치, 커밋 안 된 변경 없음, 원격보다 뒤처지지 않음, 같은 태그 없음
#   2) 버전 입력(기본: 끝자리 +1) → 지금보다 커야 함
#   3) 한 번 더 확인 → server/package.json(+lock) 버전 변경 → 커밋 → 태그 → push
#   4) GitHub Actions 빌드를 기다릴지 묻는다(gh가 있으면)
param([string]$Version)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location $repo

function Stop-WithMessage([string]$Text) { Write-Host ''; Write-Host "[중단] $Text" -ForegroundColor Red; exit 1 }
function Invoke-Tool([string]$Tool, [string[]]$Arguments) {
  & $Tool @Arguments
  if ($LASTEXITCODE -ne 0) { Stop-WithMessage "$Tool $($Arguments -join ' ') 이(가) 실패했습니다." }
}

# ── 1) 확인
foreach ($tool in @('git', 'npm')) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { Stop-WithMessage "$tool 이(가) 없습니다. 설치한 뒤 다시 실행하세요." }
}
$branch = (& git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne 'main') { Stop-WithMessage "지금 브랜치가 '$branch' 입니다. main 에서만 새 버전을 냅니다. (git checkout main)" }
$changes = @(& git status --porcelain --untracked-files=no)
if ($changes.Count) {
  Write-Host '커밋하지 않은 변경:'; $changes | ForEach-Object { Write-Host "  $_" }
  Stop-WithMessage '변경을 먼저 커밋하거나 되돌리세요. 새 버전에는 커밋된 것만 들어갑니다.'
}
Write-Host '원격 저장소 상태를 확인하고 있습니다...'
Invoke-Tool git @('fetch', 'origin', '--tags', '--quiet')
$behind = [int](& git rev-list --count 'HEAD..origin/main')
if ($behind -gt 0) { Stop-WithMessage "원격(origin/main)에 이 PC에 없는 커밋이 $behind 개 있습니다. git pull 후 다시 실행하세요." }
$ahead = [int](& git rev-list --count 'origin/main..HEAD')

# ── 2) 버전
$package = Join-Path $repo 'server\package.json'
$current = (Get-Content -LiteralPath $package -Raw -Encoding UTF8 | ConvertFrom-Json).version
$parts = $current.Split('.')
# 지금 버전이 아직 릴리스되지 않았으면(태그 없음) 그 버전을 그대로 낸다. 처음 내는 버전(예: 0.1.0)이 이 경우다.
$currentReleased = [bool](& git tag --list "v$current") -or [bool](& git ls-remote --tags origin "refs/tags/v$current")
$suggested = if ($currentReleased) { "$($parts[0]).$($parts[1]).$([int]$parts[2] + 1)" } else { $current }
Write-Host ''
Write-Host "지금 버전: $current$(if (-not $currentReleased) { ' (아직 릴리스하지 않음)' })"
if (-not $Version) {
  $answer = Read-Host "새 버전을 입력하세요 (그냥 Enter = $suggested)"
  $Version = if ($answer.Trim()) { $answer.Trim().TrimStart('v') } else { $suggested }
}
$Version = $Version.TrimStart('v')
if ($Version -notmatch '^\d+\.\d+\.\d+$') { Stop-WithMessage "버전은 숫자.숫자.숫자 형식이어야 합니다(예: 0.3.0). 입력: $Version" }
$order = ([version]$Version).CompareTo([version]$current)
if ($order -lt 0 -or ($order -eq 0 -and $currentReleased)) { Stop-WithMessage "새 버전($Version)은 지금 버전($current)보다 커야 합니다." }
$bump = $order -gt 0   # 같으면(아직 릴리스 안 한 지금 버전) 버전 변경·커밋 없이 태그만
$tag = "v$Version"
if (& git tag --list $tag) { Stop-WithMessage "태그 $tag 가 이미 있습니다. 다른 번호를 쓰세요(게시된 태그는 다시 쓰지 않습니다)." }
if (& git ls-remote --tags origin "refs/tags/$tag") { Stop-WithMessage "원격에 태그 $tag 가 이미 있습니다. 다른 번호를 쓰세요." }

# ── 3) 확인 후 진행
Write-Host ''
Write-Host '다음을 진행합니다:' -ForegroundColor Cyan
if ($bump) {
  Write-Host "  - server/package.json 버전 $current → $Version"
  Write-Host "  - 커밋 'Version $Version' + 태그 $tag"
} else {
  Write-Host "  - 지금 버전 $Version 그대로, 현재 커밋에 태그 $tag"
}
Write-Host "  - GitHub에 push (main$(if ($ahead) { ", 아직 안 올린 커밋 $ahead 개 포함" }), $tag)"
Write-Host '  - GitHub Actions가 빌드·테스트·서명 후 Release를 게시합니다(약 15분).'
$ok = Read-Host '진행할까요? (Y/N)'
if ($ok -notmatch '^[Yy]') { Write-Host '취소했습니다. 아무것도 바뀌지 않았습니다.'; exit 0 }

if ($bump) {
  Push-Location (Join-Path $repo 'server')
  try { Invoke-Tool npm @('version', $Version, '--no-git-tag-version') } finally { Pop-Location }
  Invoke-Tool git @('add', 'server/package.json', 'server/package-lock.json')
  Invoke-Tool git @('commit', '-q', '-m', "Version $Version")
}
Invoke-Tool git @('tag', '-a', $tag, '-m', $tag)
Write-Host 'GitHub에 올리고 있습니다...'
Invoke-Tool git @('push', '-q', 'origin', 'main')
Invoke-Tool git @('push', '-q', 'origin', $tag)
Write-Host ''
Write-Host "올렸습니다: $tag" -ForegroundColor Green

# ── 4) 빌드 확인
$gh = Get-Command gh -ErrorAction SilentlyContinue
if (-not $gh) {
  Write-Host 'GitHub 저장소의 Actions 탭에서 빌드를, Releases 탭에서 결과를 확인하세요.'
  exit 0
}
$watch = Read-Host '빌드가 끝날 때까지 여기서 기다릴까요? (Y/N, 약 15분)'
if ($watch -notmatch '^[Yy]') { Write-Host "나중에 확인: gh run list --branch $tag"; exit 0 }
$runId = $null
for ($i = 0; $i -lt 20 -and -not $runId; $i++) {
  Start-Sleep -Seconds 3
  $runId = (& gh run list --branch $tag --limit 1 --json databaseId --jq '.[0].databaseId' 2>$null)
}
if (-not $runId) { Write-Host "빌드를 찾지 못했습니다. Actions 탭을 확인하세요."; exit 0 }
& gh run watch $runId --exit-status --interval 30
if ($LASTEXITCODE -eq 0) {
  Write-Host ''
  Write-Host "빌드 성공. Release $tag 가 게시되었습니다." -ForegroundColor Green
  & gh release view $tag --json assets --jq '.assets[].name'
  Write-Host ''
  Write-Host '다음(중앙 서버 PC, central 폴더):'
  Write-Host "  npm run release -- fetch $tag"
  Write-Host "  npm run release -- publish $Version"
} else {
  Write-Host ''
  Write-Host '빌드가 실패했습니다. 운영_매뉴얼 9-5를 참고하세요. 실패 내용:' -ForegroundColor Red
  & gh run view $runId --log-failed 2>$null | Select-Object -Last 15
  exit 1
}
