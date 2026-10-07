param([Parameter(Mandatory=$true)][string]$Bundle)
. (Join-Path $PSScriptRoot 'package-common.ps1')
$root = Join-Path ([IO.Path]::GetTempPath()) ('mycivil3d-package-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
function Require([bool]$condition,[string]$message) { if (-not $condition) { throw $message } }
try {
  $destination = Join-Path $root '한글 설치 폴더'
  $first = Invoke-BundleInstall $Bundle $destination
  Require (Test-Path -LiteralPath $first.installed) 'initial install failed'
  # 데이터는 설치 대상과 별개로 보존된다.
  $data = Join-Path $root 'user-data'
  New-Item -ItemType Directory -Path $data | Out-Null
  Set-Content -LiteralPath (Join-Path $data 'keep.txt') -Value 'keep'
  $second = Invoke-BundleInstall $Bundle $destination
  Require (Test-Path -LiteralPath $second.backup) 'previous version was not retained'
  [void](Test-Bundle $second.installed)
  $script:moves = 0
  function Move-BundleDirectory([string]$Source,[string]$Destination) {
    $script:moves++
    if ($script:moves -eq 2) { throw 'simulated activation failure' }
    Move-Item -LiteralPath $Source -Destination $Destination
  }
  $failed = $false
  try { [void](Invoke-BundleInstall $Bundle $destination) } catch { $failed = $_.Exception.Message -match 'simulated activation failure' }
  Require $failed 'replacement failure was not exercised'
  [void](Test-Bundle $second.installed)
  Require ((Get-Content -LiteralPath (Join-Path $data 'keep.txt')).Trim() -eq 'keep') 'user data changed'
  # 파일 변조는 교체 전에 거절한다.
  $file = Join-Path $second.installed 'Contents/version.json'
  $original = [IO.File]::ReadAllBytes($file)
  [IO.File]::AppendAllText($file,'tamper')
  $rejected = $false
  try { [void](Test-Bundle $second.installed) } catch { $rejected = $true }
  Require $rejected 'tampered file was accepted'
  [IO.File]::WriteAllBytes($file,$original)
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $unsafe = Join-Path $root 'unsafe.zip'
  $archive = [IO.Compression.ZipFile]::Open($unsafe,[IO.Compression.ZipArchiveMode]::Create)
  [void]$archive.CreateEntry('../escape.txt'); $archive.Dispose()
  $rejected = $false
  try { Expand-SafeArchive $unsafe (Join-Path $root 'extract') } catch { $rejected = $true }
  Require $rejected 'zip traversal was accepted'
  Require (-not (Test-Path -LiteralPath (Join-Path $root 'escape.txt'))) 'zip escaped destination'
  [void](Test-Bundle $second.installed)
  Remove-OwnedDirectory $second.installed $destination
  Require (-not (Test-Path -LiteralPath $second.installed)) 'uninstall failed'
  Require (Test-Path -LiteralPath (Join-Path $data 'keep.txt')) 'uninstall removed user data'
  Write-Host 'Package regression passed: install, update, retained backup, rollback, tamper refusal, zip traversal refusal, uninstall, data preservation.'
} finally { Remove-OwnedDirectory $root ([IO.Path]::GetTempPath()) }
