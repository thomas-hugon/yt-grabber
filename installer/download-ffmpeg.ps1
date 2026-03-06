param(
  [Parameter(Mandatory = $true)]
  [string]$AppDir
)

$ErrorActionPreference = "Stop"
$zip = Join-Path $AppDir "ffmpeg.zip"
$tmp = Join-Path $AppDir "ffmpeg_tmp"
$exe = Join-Path $AppDir "ffmpeg.exe"

Invoke-WebRequest -Uri "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl-essentials.zip" -OutFile $zip -UseBasicParsing
$sums = (Invoke-WebRequest -Uri "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/checksums.sha256" -UseBasicParsing).Content
$line = $sums -split "`n" | Where-Object { $_ -match "ffmpeg-master-latest-win64-lgpl-essentials.zip$" } | Select-Object -First 1
if (-not $line) { throw "Unable to find ffmpeg checksum line" }

$expected = ($line -split "\s+")[0].ToLower()
$actual = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower()
if ($expected -ne $actual) {
  throw "ffmpeg checksum mismatch"
}

Expand-Archive -Path $zip -DestinationPath $tmp -Force
$found = Get-ChildItem $tmp -Filter "ffmpeg.exe" -Recurse | Select-Object -First 1
if (-not $found) { throw "ffmpeg.exe not found in extracted archive" }
Copy-Item $found.FullName $exe -Force
Remove-Item $zip -Force
Remove-Item $tmp -Recurse -Force
