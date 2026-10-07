# 중앙 서버 HTTPS 인증서를 만든다(사내용 자체 서명). 이미 있으면 그대로 둔다.
#   <DataDir>\tls\server.pfx   인증서 + 비밀 키 (암호: server.pass)
#   <DataDir>\tls\server.cer   인증서(공개). 이 지문(SHA-256)을 설치 묶음(server.json)과 각 PC가 고정해 믿는다.
# 공용 인증기관이 필요 없다. 클라이언트는 이름·기관이 아니라 지문으로 확인한다.
param([Parameter(Mandatory = $true)][string]$DataDir, [int]$Years = 5)
$ErrorActionPreference = 'Stop'
$folder = Join-Path $DataDir 'tls'
$pfx = Join-Path $folder 'server.pfx'
if (Test-Path -LiteralPath $pfx) { return }
New-Item -ItemType Directory -Path $folder -Force | Out-Null
$bytes = New-Object byte[] 24
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$passText = [Convert]::ToBase64String($bytes)
$names = @([Environment]::MachineName, 'localhost')
$cert = New-SelfSignedCertificate -Subject 'CN=my-civil3d-mcp central' -DnsName $names -CertStoreLocation 'Cert:\CurrentUser\My' `
  -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -NotAfter (Get-Date).AddYears($Years)
try {
  $password = ConvertTo-SecureString -String $passText -AsPlainText -Force
  Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $password | Out-Null
  Export-Certificate -Cert $cert -FilePath (Join-Path $folder 'server.cer') -Type CERT | Out-Null
  [IO.File]::WriteAllText((Join-Path $folder 'server.pass'), $passText, [Text.UTF8Encoding]::new($false))
} finally {
  # 인증서 저장소에는 남기지 않는다(파일만 쓴다).
  Remove-Item -LiteralPath ("Cert:\CurrentUser\My\" + $cert.Thumbprint) -DeleteKey -ErrorAction SilentlyContinue
}
Write-Host "HTTPS 인증서를 만들었습니다: $pfx"
