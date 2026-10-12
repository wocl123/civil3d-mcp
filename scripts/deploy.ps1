param([string]$Version, [switch]$Required, [string]$GitHubRepo, [string]$AdminEmail,
      [string]$IngestUrl, [string]$CollectionRoot, [string]$NodeArchive, [switch]$NuGetAutodesk,
      [switch]$SkipBuild, [string]$DriveRoot, [string]$FolderLink)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'package-common.ps1')
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$mutex = New-Object Threading.Mutex($false, 'Local\MyCivil3DMcpDeploy')
$owned = $false
try {
  try { $owned = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owned = $true }
  if (-not $owned) { throw '다른 배포 작업이 진행 중입니다.' }
  $settingsFile = Join-Path $repo '.drive-deploy.json'
  $settings = if (Test-Path -LiteralPath $settingsFile) { Get-Content -LiteralPath $settingsFile -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
  function Value([string]$Given, [string]$Name, [string]$Prompt) {
    if ($Given) { return $Given }
    if ($settings -and $settings.PSObject.Properties[$Name] -and $settings.$Name) { return [string]$settings.$Name }
    return (Read-Host $Prompt).Trim()
  }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw '관리자 빌드 PC에 Node.js가 필요합니다.' }
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw '관리자 배포 PC에 GitHub CLI(gh)가 필요합니다. 설치 후 gh auth login을 실행하세요.' }
  & gh auth status
  if ($LASTEXITCODE -ne 0) { throw '관리자 GitHub 로그인이 필요합니다: gh auth login' }
  if (-not $GitHubRepo -and $settings -and $settings.PSObject.Properties['githubRepo']) { $GitHubRepo = [string]$settings.githubRepo }
  if (-not $GitHubRepo) {
    $origin = (& git -C $repo remote get-url origin).Trim()
    if ($origin -match 'github\.com[:/]([^/]+)/([^/]+?)(?:\.git)?$') { $GitHubRepo = "$($Matches[1])/$($Matches[2])" }
    else { $GitHubRepo = (Read-Host '공개 배포용 GitHub 저장소 (소유자/이름)').Trim() }
  }
  if ($GitHubRepo -notmatch '^[a-z\d][a-z\d-]{0,38}/[a-z\d_.-]{1,100}$' -or $GitHubRepo.Split('/')[1] -in @('.', '..')) { throw 'GitHub 저장소 형식 오류' }
  $AdminEmail = Value $AdminEmail 'adminEmail' '자동 수신 웹앱을 소유한 관리자 Google 메일'
  if ($AdminEmail -notmatch '^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$') { throw '관리자 메일 형식 오류' }
  $IngestUrl = Value $IngestUrl 'ingestUrl' '자동 수신 Apps Script URL (.../exec)'
  if ($IngestUrl -notmatch '^https://script\.google\.com/macros/s/[\w-]{20,200}/exec$') { throw '자동 수신 URL 형식 오류' }
  if (-not $CollectionRoot -and $settings -and $settings.PSObject.Properties['collectionRoot']) { $CollectionRoot = [string]$settings.collectionRoot }
  if (-not $CollectionRoot) { $CollectionRoot = (Read-Host '비공개 MyCivil3DMcp-data 로컬 경로').Trim() }
  if (-not (Test-Path -LiteralPath $CollectionRoot -PathType Container)) { throw '비공개 수집폴더가 아직 동기화되지 않았습니다.' }
  if (-not $DriveRoot -and $settings -and $settings.PSObject.Properties['driveRoot']) { $DriveRoot = [string]$settings.driveRoot }
  if ($DriveRoot) {
    $publicRoot = [IO.Path]::GetFullPath($DriveRoot).TrimEnd('\')
    $privateRoot = [IO.Path]::GetFullPath($CollectionRoot).TrimEnd('\')
    if ($privateRoot -eq $publicRoot -or $privateRoot.StartsWith($publicRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '수집폴더를 공개 배포폴더 안에 둘 수 없습니다.' }
  }
  & node (Join-Path $PSScriptRoot 'ingest-config.mjs') --probe $IngestUrl
  if ($LASTEXITCODE -ne 0) { throw '수신 웹앱 준비 확인 실패' }
  $current = (Get-Content -LiteralPath (Join-Path $repo 'server/package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
  $suggested = $current
  if ($settings -and $settings.PSObject.Properties['lastPublishedVersion'] -and $settings.lastPublishedVersion -eq $current) {
    $parts = $current.Split('.'); $suggested = "$($parts[0]).$($parts[1]).$([int]$parts[2]+1)"
  }
  if (-not $Version) { $Version = (Read-Host "배포 버전 (Enter = $suggested)").Trim(); if (-not $Version) { $Version = $suggested } }
  if ($Version -notmatch '^\d+\.\d+\.\d+$' -or ([version]$Version -lt [version]$current)) { throw '현재 버전 이상의 숫자.숫자.숫자 형식을 사용하세요.' }
  $config = [ordered]@{}
  if ($settings) { foreach ($property in $settings.PSObject.Properties) { $config[$property.Name] = $property.Value } }
  $config.version = $Version; $config.githubRepo = $GitHubRepo; $config.adminEmail = $AdminEmail
  $config.ingestUrl = $IngestUrl; $config.collectionRoot = $CollectionRoot; $config.required = [bool]$Required
  [IO.File]::WriteAllText($settingsFile, ($config | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
  if (-not $env:MY_CIVIL3D_SIGNING_KEY_FILE -and -not $env:MY_CIVIL3D_SIGNING_KEY) { $env:MY_CIVIL3D_SIGNING_KEY_FILE = Join-Path $env:USERPROFILE '.mycivil3d/release-signing-key.pem' }
  if (-not $env:MY_CIVIL3D_SIGNING_KEY -and -not (Test-Path -LiteralPath $env:MY_CIVIL3D_SIGNING_KEY_FILE)) { throw '공식 서명 키가 없습니다.' }
  if ($Version -ne $current) {
    if ($SkipBuild) { throw '버전 변경 시 새 빌드가 필요합니다.' }
    Push-Location (Join-Path $repo 'server')
    try { & npm version $Version --no-git-tag-version; if ($LASTEXITCODE -ne 0) { throw '버전 변경 실패' } } finally { Pop-Location }
  }
  $env:MY_CIVIL3D_ADMIN_EMAIL = $AdminEmail
  $env:MY_CIVIL3D_GITHUB_REPO = $GitHubRepo
  $env:MY_CIVIL3D_INGEST_URL = $IngestUrl
  Remove-Item Env:MY_CIVIL3D_RELEASE_MANIFEST_ID -ErrorAction SilentlyContinue
  if (-not $SkipBuild) {
    $build = @{ RequireSignature=$true }
    if ($NodeArchive) { $build.NodeArchive = $NodeArchive }
    if ($NuGetAutodesk) { $build.NuGetAutodesk = $true }
    & (Join-Path $PSScriptRoot 'package.ps1') @build
  }
  & node (Join-Path $PSScriptRoot 'github-publish.mjs') $settingsFile
  if ($LASTEXITCODE -ne 0) { throw 'GitHub 게시/공개 다운로드 확인 실패. 동일 산출물 재확인은 -SkipBuild로 할 수 있습니다.' }
  $config.lastPublishedVersion = $Version
  [IO.File]::WriteAllText($settingsFile, ($config | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
  Write-Host "사용자 설치 안내: https://github.com/$GitHubRepo/releases/latest"
  Write-Host '관리자 데이터 관리는 관리자실행.bat으로 실행하세요.'
} finally { if ($owned) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
