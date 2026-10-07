# 배포 파일 검증·설치는 빌드와 설치 스크립트에서 같은 구현을 사용한다.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-Within([string]$Path, [string]$Root) {
  $full = [IO.Path]::GetFullPath($Path)
  $base = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  if (-not $full.StartsWith($base + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "대상 경로가 지정한 폴더 밖입니다: $full"
  }
  return $full
}
function Assert-NoReparse([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force
  while ($null -ne $item) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "연결된 경로는 사용할 수 없습니다: $($item.FullName)" }
    $item = if ($item -is [IO.DirectoryInfo]) { $item.Parent } else { $item.Directory }
  }
}
function Remove-OwnedDirectory([string]$Path, [string]$Root) {
  $full = Assert-Within $Path $Root
  if (Test-Path -LiteralPath $full) {
    Assert-NoReparse $full
    Get-ChildItem -LiteralPath $full -Recurse -Force | ForEach-Object {
      if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "정리 대상에 연결된 경로가 있습니다: $($_.FullName)" }
    }
    Remove-Item -LiteralPath $full -Recurse -Force
  }
}
function Get-BundleFiles([string]$Bundle) {
  Assert-NoReparse $Bundle
  $base = [IO.Path]::GetFullPath($Bundle).TrimEnd('\', '/')
  foreach ($item in Get-ChildItem -LiteralPath $Bundle -Recurse -Force) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "번들에 연결된 파일이 있습니다: $($item.FullName)" }
    if (-not $item.PSIsContainer) {
      $relative = $item.FullName.Substring($base.Length + 1).Replace('\', '/')
      if ($relative -ne 'Contents/manifest.json' -and $relative -ne 'Contents/manifest.sig') { $relative }   # 목록과 그 서명은 목록에 넣지 않는다
    }
  }
}
function Write-BundleManifest([string]$Bundle) {
  $entries = @(Get-BundleFiles $Bundle | Sort-Object | ForEach-Object {
    $file = Join-Path $Bundle $_
    [ordered]@{ path = $_; bytes = (Get-Item -LiteralPath $file).Length; sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }
  })
  @{ schemaVersion = 1; files = $entries } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $Bundle 'Contents/manifest.json') -Encoding UTF8
}
function Test-Bundle([string]$Bundle) {
  # 먼저 디렉터리 트리의 연결 속성을 검사한다. 각 파일마다 같은 조상을 다시 읽지 않는다.
  $actual = @(Get-BundleFiles $Bundle)
  $manifest = Get-Content -LiteralPath (Join-Path $Bundle 'Contents/manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($manifest.schemaVersion -ne 1) { throw '지원하지 않는 manifest입니다.' }
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in $manifest.files) {
    if ([string]::IsNullOrWhiteSpace($entry.path) -or $entry.path -match '(^|[\\/])\.\.([\\/]|$)|:|^[/\\]' -or $entry.path -eq 'Contents/manifest.json' -or $entry.path -eq 'Contents/manifest.sig') { throw '잘못된 manifest 경로입니다.' }
    if (-not $seen.Add($entry.path.Replace('\','/'))) { throw '중복 manifest 경로입니다.' }
    $file = Assert-Within (Join-Path $Bundle $entry.path) $Bundle
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "배포 파일이 없습니다: $($entry.path)" }
    $fileInfo = Get-Item -LiteralPath $file
    if ($fileInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '검사 중 연결된 파일로 바뀌었습니다.' }
    if ($fileInfo.Length -ne $entry.bytes -or $entry.sha256 -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $entry.sha256) { throw "파일 검증 실패: $($entry.path)" }
  }
  if ($actual.Count -ne $seen.Count -or @($actual | Where-Object { -not $seen.Contains($_) }).Count) { throw 'manifest에 없는 파일이 있습니다.' }
  $required = @('PackageContents.xml','Contents/plugin/MyCivil3DMcp.Plugin.dll','Contents/plugin/MyCivil3DMcp.Plugin.deps.json',
    'Contents/node/node.exe','Contents/node/npm.cmd','Contents/node/node_modules/npm/bin/npm-cli.js','Contents/node/LICENSE',
    'Contents/server/package.json','Contents/server/build/localService.js','Contents/server/build/index.js',
    'Contents/server/skills/civil3d-palette/SKILL.md','Contents/server/setup/setup-ai-cli.ps1','Contents/version.json',
    'Contents/server/knowledge-defaults/criteria/도로구조규칙.json')
  foreach ($file in $required) { if (-not $seen.Contains($file)) { throw "필수 배포 파일 누락: $file" } }
  [xml]$xml = Get-Content -LiteralPath (Join-Path $Bundle 'PackageContents.xml') -Raw -Encoding UTF8
  $runtime = $xml.ApplicationPackage.Components.RuntimeRequirements
  if ($runtime.SeriesMin -ne 'R25.0' -or $runtime.SeriesMax -ne 'R25.0' -or $runtime.Platform -ne 'Civil3D' -or $runtime.OS -ne 'Win64') { throw '지원 CAD 설정이 다릅니다.' }
  $version = Get-Content -LiteralPath (Join-Path $Bundle 'Contents/version.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($version.version -ne $xml.ApplicationPackage.AppVersion -or $version.nodeVersion -notmatch '^22\.\d+\.\d+$') { throw '버전 정보가 올바르지 않습니다.' }
  return $version
}
function Expand-SafeArchive([string]$Archive, [string]$Destination) {
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead([IO.Path]::GetFullPath($Archive))
  try {
    $paths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $zip.Entries) {
      if ($entry.FullName -match '(^|[\\/])\.\.([\\/]|$)|:|^[/\\]') { throw '압축 파일에 잘못된 경로가 있습니다.' }
      $target = Assert-Within (Join-Path $Destination $entry.FullName) $Destination
      if (-not $paths.Add($target)) { throw '압축 파일에 중복 경로가 있습니다.' }
    }
  } finally { $zip.Dispose() }
  [IO.Compression.ZipFile]::ExtractToDirectory([IO.Path]::GetFullPath($Archive), [IO.Path]::GetFullPath($Destination))
}
function Assert-BundleStopped([string]$Bundle) {
  if (Get-Process -Name acad -ErrorAction SilentlyContinue) { throw 'Civil 3D/AutoCAD를 모두 종료한 뒤 다시 실행하세요.' }
  $node = [IO.Path]::GetFullPath((Join-Path $Bundle 'Contents/node/node.exe'))
  $running = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.ExecutablePath -and [string]::Equals($_.ExecutablePath,$node,[StringComparison]::OrdinalIgnoreCase) }
  if ($running) { throw '이 번들의 Node 프로세스가 아직 실행 중입니다. 서비스 종료 후 다시 실행하세요.' }
}
function Move-BundleDirectory([string]$Source, [string]$Destination) { Move-Item -LiteralPath $Source -Destination $Destination }
function Invoke-BundleInstall([string]$Source, [string]$DestinationRoot) {
  # 긴 파일 검사 중에도 진행 상태를 표시한다. 종료 안내는 실제 프로세스를 발견했을 때만 나온다.
  Write-Host '[1/4] 설치 파일을 검증하고 있습니다...'
  [void](Test-Bundle $Source)
  New-Item -ItemType Directory -Path $DestinationRoot -Force | Out-Null
  Assert-NoReparse $DestinationRoot
  $target = Assert-Within (Join-Path $DestinationRoot 'MyCivil3DMcp.bundle') $DestinationRoot
  $work = Assert-Within (Join-Path $DestinationRoot ('.mycivil3d-' + [guid]::NewGuid().ToString('N'))) $DestinationRoot
  $backup = Assert-Within ($target + '.backup-' + [guid]::NewGuid().ToString('N')) $DestinationRoot
  New-Item -ItemType Directory -Path $work | Out-Null
  $stage = Join-Path $work 'MyCivil3DMcp.bundle'
  $movedOld = $false
  try {
    Write-Host '[2/4] 설치 파일을 복사하고 있습니다...'
    Copy-Item -LiteralPath $Source -Destination $stage -Recurse
    Write-Host '[3/4] 복사한 파일을 확인하고 있습니다...'
    [void](Test-Bundle $stage)
    Write-Host '[4/4] 설치를 마무리하고 있습니다...'
    if (Test-Path -LiteralPath $target) {
      Assert-NoReparse $target
      Move-BundleDirectory $target $backup
      $movedOld = $true
    }
    try { Move-BundleDirectory $stage $target }
    catch {
      # 교체 실패 시 이미 옮긴 기존 버전을 복구한다. 사용자 데이터는 대상에 포함하지 않는다.
      if ($movedOld) { Move-BundleDirectory $backup $target; $movedOld = $false }
      throw
    }
    [void](Test-Bundle $target)
    return [pscustomobject]@{ installed = $target; backup = $(if ($movedOld) { $backup } else { $null }) }
  } finally { Remove-OwnedDirectory $work $DestinationRoot }
}

# ── 온라인 설치: 설치.bat 옆에 server.json(중앙 서버 주소, 가입키)이 있으면 서버의 배포 버전을 확인해 받는다.
function Read-ServerSettings([string]$File) {
  $settings = Get-Content -LiteralPath $File -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not ($settings.url -match '^https?://[^/\s?#@]+(/[^\s?#]*)?$') -or -not $settings.enrollKey) { throw 'server.json의 url 또는 enrollKey가 올바르지 않습니다.' }
  $url = ([string]$settings.url).TrimEnd('/')
  $uri = [Uri]$url
  $pin = if ($settings.PSObject.Properties['certSha256']) { ([string]$settings.certSha256).Replace(':', '').ToLowerInvariant() } else { '' }
  # 다른 PC의 서버는 HTTPS + 인증서 지문으로만 연결한다. HTTP는 이 PC 안(127.0.0.1, localhost)만.
  if ($uri.Scheme -eq 'https' -and $pin -notmatch '^[a-f0-9]{64}$') { throw 'server.json에 서버 인증서 지문(certSha256)이 없습니다. 관리자에게 새 설치 묶음을 받으세요.' }
  if ($uri.Scheme -eq 'http' -and -not $uri.IsLoopback) { throw '다른 PC의 중앙 서버는 HTTPS로만 연결합니다. 관리자에게 새 설치 묶음을 받으세요.' }
  return [pscustomobject]@{ url = $url; enrollKey = [string]$settings.enrollKey; certSha256 = $pin }
}
# HTTPS 서버 인증서를 지문으로 고정한다(공용 인증기관 대신). 이 설치 과정의 모든 요청에 적용된다.
function Enable-CertificatePin([string]$Pin) {
  if (-not $Pin) { return }
  if (-not ('MyCivil3DCertificatePin' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Net;
using System.Net.Security;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
public static class MyCivil3DCertificatePin {
  static string expected;
  public static void Install(string pin) { expected = pin; ServicePointManager.ServerCertificateValidationCallback = Check; }
  static bool Check(object sender, X509Certificate certificate, X509Chain chain, SslPolicyErrors errors) {
    if (certificate == null || expected == null) return false;
    using (SHA256 sha = SHA256.Create()) {
      string actual = BitConverter.ToString(sha.ComputeHash(certificate.GetRawCertData())).Replace("-", "").ToLowerInvariant();
      return actual == expected;
    }
  }
}
'@
  }
  [MyCivil3DCertificatePin]::Install($Pin)
}
function Get-InstalledVersion([string]$Bundle) {
  $file = Join-Path $Bundle 'Contents/version.json'
  if (-not (Test-Path -LiteralPath $file)) { return $null }
  try { return [string](Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch { return $null }
}
function Compare-ProductVersion([string]$A, [string]$B) { return ([version]$A).CompareTo([version]$B) }
function Get-ServerRelease($Server) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  Enable-CertificatePin $Server.certSha256
  $release = Invoke-RestMethod -Uri "$($Server.url)/v1/release" -Headers @{ 'x-enroll-key' = $Server.enrollKey } -TimeoutSec 20 -UseBasicParsing
  if ($release.PSObject.Properties['none']) { return $null }   # StrictMode: 없는 속성을 읽으면 오류
  if (-not ($release.version -match '^\d+\.\d+\.\d+$') -or -not ($release.sha256 -match '^[a-f\d]{64}$')) { throw '서버의 배포 정보가 올바르지 않습니다.' }
  return $release
}
# 받은 파일의 크기와 SHA-256이 서버가 알려 준 값과 같아야 한다. 다르면 지우고 멈춘다.
function Save-ServerRelease($Server, $Release, [string]$Folder) {
  $file = Join-Path $Folder ("MyCivil3DMcp-$($Release.version)-win-x64.zip")
  $previous = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'   # 진행 표시가 다운로드를 크게 늦춘다(PowerShell 5.1)
  try { Invoke-WebRequest -Uri "$($Server.url)/v1/release/download?version=$($Release.version)" -Headers @{ 'x-enroll-key' = $Server.enrollKey } -OutFile $file -TimeoutSec 600 -UseBasicParsing }
  finally { $ProgressPreference = $previous }
  $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
  if ((Get-Item -LiteralPath $file).Length -ne [long]$Release.size -or $hash -ne $Release.sha256) {
    Remove-Item -LiteralPath $file -Force
    throw '받은 설치 파일이 서버의 정보와 다릅니다(손상 또는 변조). 다시 시도하세요.'
  }
  return $file
}
# 아직 중앙 서버에 연결하지 않은 PC면, 서비스가 다음에 켜질 때 이 가입키로 등록하도록 남긴다(등록 후 서비스가 지운다).
function Save-CentralJoin($Server, [string]$DataDir) {
  $settingsFile = Join-Path $DataDir 'settings.json'
  if (Test-Path -LiteralPath $settingsFile) {
    try { if ((Get-Content -LiteralPath $settingsFile -Raw -Encoding UTF8 | ConvertFrom-Json).central) { return $false } } catch { }
  }
  New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
  $join = [ordered]@{ url = $Server.url; enrollKey = $Server.enrollKey }
  if ($Server.certSha256) { $join.certSha256 = $Server.certSha256 }
  $json = [pscustomobject]$join | ConvertTo-Json
  [IO.File]::WriteAllText((Join-Path $DataDir 'central-join.json'), $json, [Text.UTF8Encoding]::new($false))
  return $true
}

# ── 설치 폴더 정리: 끊긴 설치가 남긴 작업 폴더와 쌓인 이전 버전 백업(각 120MB 남짓)
# 1시간 넘은 작업 폴더만 지운다(지금 다른 설치가 쓰는 폴더는 건드리지 않는다).
function Remove-StaleInstallWork([string]$DestinationRoot) {
  if (-not (Test-Path -LiteralPath $DestinationRoot)) { return }
  Get-ChildItem -LiteralPath $DestinationRoot -Directory -Force -Filter '.mycivil3d-*' |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddHours(-1) } |
    ForEach-Object { try { Remove-OwnedDirectory $_.FullName $DestinationRoot } catch { Write-Host "이전 작업 폴더를 지우지 못했습니다: $($_.Exception.Message)" } }
}
# 되돌릴 수 있도록 이번 설치가 만든 백업 하나만 남긴다(폴더를 옮기면 시각이 유지되므로 시각으로 고르지 않는다).
function Remove-OldBackups([string]$DestinationRoot, [string]$Keep) {
  if (-not (Test-Path -LiteralPath $DestinationRoot)) { return }
  $keepFull = if ($Keep) { [IO.Path]::GetFullPath($Keep) } else { '' }
  Get-ChildItem -LiteralPath $DestinationRoot -Directory -Force -Filter 'MyCivil3DMcp.bundle.backup-*' |
    Where-Object { -not [string]::Equals($_.FullName, $keepFull, [StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { try { Remove-OwnedDirectory $_.FullName $DestinationRoot } catch { Write-Host "이전 백업을 지우지 못했습니다: $($_.Exception.Message)" } }
}

# ── 서명: 릴리스는 Contents/manifest.json(모든 파일의 SHA-256 목록)에 서명한다. 서명이 맞고 Test-Bundle이
# 통과하면 번들의 모든 파일이 서명한 그대로다. 공개 키는 설치 파일 옆의 release-public-key.xml(이 스크립트와 함께 배포).
function Get-TrustedKeyFile { return (Join-Path $PSScriptRoot 'release-public-key.xml') }
function Assert-BundleSignature([string]$Bundle, [string]$KeyFile = (Get-TrustedKeyFile)) {
  $manifest = Join-Path $Bundle 'Contents/manifest.json'
  $signature = Join-Path $Bundle 'Contents/manifest.sig'
  if (-not (Test-Path -LiteralPath $signature)) { throw '서명이 없는 설치 파일입니다. 공식 배포본만 설치할 수 있습니다.' }
  if (-not (Test-Path -LiteralPath $KeyFile)) { throw "서명 확인용 공개 키가 없습니다: $KeyFile" }
  $rsa = [Security.Cryptography.RSACryptoServiceProvider]::new()
  try {
    $rsa.FromXmlString((Get-Content -LiteralPath $KeyFile -Raw).Trim())
    $bytes = [IO.File]::ReadAllBytes($manifest)
    $sig = [Convert]::FromBase64String((Get-Content -LiteralPath $signature -Raw).Trim())
    if (-not $rsa.VerifyData($bytes, 'SHA256', $sig)) { throw '설치 파일의 서명이 맞지 않습니다(변조되었거나 공식 배포본이 아님). 설치하지 않습니다.' }
  } finally { $rsa.Dispose() }
}
