param([Parameter(Mandatory=$true)][string]$Archive, [Parameter(Mandatory=$true)][string]$Output)
$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework C# compiler is required.' }
New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Output))) -Force | Out-Null
& $compiler /nologo /target:winexe /platform:x64 /optimize+ "/out:$Output" "/resource:$Archive,payload.zip" /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll /reference:System.Windows.Forms.dll (Join-Path $PSScriptRoot 'Installer.cs')
if ($LASTEXITCODE -ne 0) { throw 'Installer EXE build failed.' }
