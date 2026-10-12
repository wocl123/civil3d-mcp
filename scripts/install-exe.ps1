# Trusted helper from the installed bundle. Verify EXE before extracting/running anything from it.
param([Parameter(Mandatory=$true)][string]$Archive, [Parameter(Mandatory=$true)][string]$DataDir,
      [string]$DestinationRoot, [switch]$SkipRunningCheck)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'package-common.ps1')
$metadata = Get-Content -LiteralPath ($Archive + '.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$bytes = [IO.File]::ReadAllBytes($Archive)
if ($bytes.LongLength -ne $metadata.size -or (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $metadata.sha256) { throw 'Installer EXE hash mismatch.' }
$rsa = New-Object Security.Cryptography.RSACryptoServiceProvider
try {
  $rsa.FromXmlString([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'release-public-key.xml')))
  if (-not $rsa.VerifyData($bytes, 'SHA256', [Convert]::FromBase64String($metadata.signature))) { throw 'Installer EXE signature mismatch.' }
} finally { $rsa.Dispose() }
$work = Join-Path ([IO.Path]::GetTempPath()) ('MyCivil3DMcp-update-' + [guid]::NewGuid().ToString('N'))
try {
  $process = Start-Process -FilePath $Archive -ArgumentList @('--extract', ('"' + $work + '"')) -WindowStyle Hidden -PassThru -Wait
  if ($process.ExitCode -ne 0) { throw 'Installer extraction failed.' }
  $arguments = @{ Archive = (Join-Path $work 'MyCivil3DMcp.bundle.zip'); DataDir = $DataDir; TrustedKeyFile = (Join-Path $PSScriptRoot 'release-public-key.xml') }
  if ($DestinationRoot) { $arguments.DestinationRoot = $DestinationRoot }
  if ($SkipRunningCheck) { $arguments.SkipRunningCheck = $true }
  # Reuse the installed installer, rather than the downloaded script.
  & (Join-Path $PSScriptRoot 'install.ps1') @arguments
  Save-TeamInfo (Join-Path $work 'team.json') $DataDir
} finally {
  if (Test-Path -LiteralPath $work) { Remove-OwnedDirectory $work ([IO.Path]::GetTempPath()) }
}
