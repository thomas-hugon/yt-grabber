param(
  [Parameter(Mandatory = $true)]
  [string]$AppDir,
  [string]$ApiToken = ""
)

$ErrorActionPreference = "Stop"
$token = $ApiToken
if ([string]::IsNullOrWhiteSpace($token)) {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $token = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""
}

$path = Join-Path $AppDir "ytgrabber.token"
Set-Content -Path $path -Value $token -NoNewline
