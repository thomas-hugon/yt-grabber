param(
  [Parameter(Mandatory = $true)]
  [string]$AppDir,
  [string]$ApiToken = ""
)

$ErrorActionPreference = "Stop"
$token = $ApiToken
$path = Join-Path $AppDir "ytgrabber.token"

if ([string]::IsNullOrWhiteSpace($token) -and (Test-Path $path)) {
  $token = (Get-Content -Path $path -Raw).Trim()
}

if ([string]::IsNullOrWhiteSpace($token)) {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $token = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""
}

Set-Content -Path $path -Value $token -NoNewline
