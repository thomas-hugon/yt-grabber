param(
  [Parameter(Mandatory = $true)]
  [string]$AppDir
)

$ErrorActionPreference = "Stop"
$out = Join-Path $AppDir "yt-dlp.exe"

Invoke-WebRequest -Uri "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" -OutFile $out -UseBasicParsing
$sums = (Invoke-WebRequest -Uri "https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS" -UseBasicParsing).Content
$line = $sums -split "`n" | Where-Object { $_ -match "\syt-dlp$" } | Select-Object -First 1
if (-not $line) { throw "Unable to find yt-dlp checksum line" }

$expected = ($line -split "\s+")[0].ToLower()
$actual = (Get-FileHash -Algorithm SHA256 $out).Hash.ToLower()
if ($expected -ne $actual) {
  throw "yt-dlp checksum mismatch"
}
