# 번들 폴더로 설치 EXE(Inno Setup)를 만든다. 설치 동작은 installer.iss 참고.
param(
  [Parameter(Mandatory=$true)][string]$Bundle,
  [Parameter(Mandatory=$true)][string]$Version,
  [Parameter(Mandatory=$true)][string]$Output,
  [string]$TeamFile
)
$ErrorActionPreference = 'Stop'

function Find-InnoCompiler {
  $candidates = @(
    $env:MY_CIVIL3D_ISCC,
    (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
    (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe')
  )
  foreach ($path in $candidates) {
    if ($path -and (Test-Path -LiteralPath $path)) {
      return $path
    }
  }

  $command = Get-Command ISCC.exe -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  throw 'Inno Setup 6이 필요합니다: https://jrsoftware.org/isdl.php (또는 winget install JRSoftware.InnoSetup)'
}

$compiler = Find-InnoCompiler
$outputFull = [IO.Path]::GetFullPath($Output)
$outputDir = [IO.Path]::GetDirectoryName($outputFull)
$outputName = [IO.Path]::GetFileNameWithoutExtension($outputFull)
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null

$arguments = @('/Q', "/DAppVersion=$Version", "/DBundleDir=$([IO.Path]::GetFullPath($Bundle))", "/O$outputDir", "/F$outputName")
if ($TeamFile) {
  $arguments += "/DTeamFile=$([IO.Path]::GetFullPath($TeamFile))"
}

& $compiler @arguments (Join-Path $PSScriptRoot 'installer.iss')
if ($LASTEXITCODE -ne 0) {
  throw "설치 EXE 빌드 실패(ISCC 종료 코드 $LASTEXITCODE)"
}
