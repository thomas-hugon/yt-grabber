param(
  [Parameter(Mandatory = $true)]
  [string]$AppDir,
  [string]$JsRuntimePath = "",
  [string]$DownloadNodeJs = "",
  [string]$RemoveOnly = ""
)

$ErrorActionPreference = "Stop"
$runtimeDest = Join-Path $AppDir "ytg-nodejs.exe"
$configDir = Join-Path $env:APPDATA "yt-dlp"
$configFile = Join-Path $configDir "config"
$markerStart = "# BEGIN YTGRABBER JS RUNTIME"
$markerEnd = "# END YTGRABBER JS RUNTIME"

function Remove-YtGrabberRuntimeBlock {
  if (-not (Test-Path $configFile)) {
    return
  }
  $raw = Get-Content -Path $configFile -Raw
  $escapedStart = [Regex]::Escape($markerStart)
  $escapedEnd = [Regex]::Escape($markerEnd)
  $updated = [Regex]::Replace($raw, "(?ms)\r?\n?$escapedStart.*?$escapedEnd\r?\n?", "")
  $updated = $updated.TrimEnd("`r", "`n")
  if ([string]::IsNullOrWhiteSpace($updated)) {
    Remove-Item $configFile -Force
    return
  }
  Set-Content -Path $configFile -Value ($updated + "`r`n") -NoNewline
}

function Resolve-DownloadNodeJsRequested {
  if ([string]::IsNullOrWhiteSpace($DownloadNodeJs)) {
    return $false
  }
  $value = $DownloadNodeJs.Trim().ToLowerInvariant()
  return $value -in @("1", "true", "yes", "on")
}

function Resolve-RemoveOnlyRequested {
  if ([string]::IsNullOrWhiteSpace($RemoveOnly)) {
    return $false
  }
  $value = $RemoveOnly.Trim().ToLowerInvariant()
  return $value -in @("1", "true", "yes", "on")
}

function Install-NodeRuntimeFromDownload {
  $arch = $env:PROCESSOR_ARCHITECTURE
  $fileName = switch -Regex ($arch) {
    "^(AMD64|x86_64)$" { "win-x64-zip" ; break }
    "^(ARM64|aarch64)$" { "win-arm64-zip" ; break }
    default { throw "Unsupported Windows architecture for Node.js download: $arch" }
  }

  $tmpDir = Join-Path $env:TEMP ("ytg-nodejs-" + [Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $tmpDir | Out-Null
  try {
    $indexUrl = "https://nodejs.org/dist/index.json"
    $index = Invoke-WebRequest -Uri $indexUrl -UseBasicParsing | Select-Object -ExpandProperty Content | ConvertFrom-Json
    $release = $index | Where-Object { $_.lts -and $_.files -contains $fileName } | Select-Object -First 1
    if (-not $release) {
      throw "Unable to find an LTS Node.js release for $fileName"
    }

    $version = $release.version
    $archiveName = "node-$version-$fileName.zip"
    $baseUrl = "https://nodejs.org/dist/$version"
    $archivePath = Join-Path $tmpDir $archiveName
    $sumsPath = Join-Path $tmpDir "SHASUMS256.txt"

    Invoke-WebRequest -Uri "$baseUrl/$archiveName" -OutFile $archivePath -UseBasicParsing
    Invoke-WebRequest -Uri "$baseUrl/SHASUMS256.txt" -OutFile $sumsPath -UseBasicParsing

    $line = (Get-Content -Path $sumsPath | Where-Object { $_ -match ([Regex]::Escape($archiveName) + "$") } | Select-Object -First 1)
    if (-not $line) {
      throw "Unable to find checksum for $archiveName"
    }
    $expected = ($line -split "\s+")[0].ToLowerInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 $archivePath).Hash.ToLowerInvariant()
    if ($expected -ne $actual) {
      throw "Node.js archive checksum mismatch"
    }

    $extractDir = Join-Path $tmpDir "extract"
    Expand-Archive -Path $archivePath -DestinationPath $extractDir -Force
    $nodeExe = Get-ChildItem -Path $extractDir -Filter "node.exe" -Recurse | Select-Object -First 1
    if (-not $nodeExe) {
      throw "node.exe not found in extracted archive"
    }

    Copy-Item $nodeExe.FullName $runtimeDest -Force
  } finally {
    Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Write-YtGrabberRuntimeBlock {
  param([string]$RuntimePath)

  New-Item -ItemType Directory -Force -Path $configDir | Out-Null
  $normalized = $RuntimePath.Replace("\", "/")
  $block = @(
    $markerStart
    "--js-runtimes node:$normalized"
    $markerEnd
  ) -join "`r`n"

  $existing = ""
  if (Test-Path $configFile) {
    $existing = Get-Content -Path $configFile -Raw
  }

  $escapedStart = [Regex]::Escape($markerStart)
  $escapedEnd = [Regex]::Escape($markerEnd)
  $cleaned = [Regex]::Replace($existing, "(?ms)\r?\n?$escapedStart.*?$escapedEnd\r?\n?", "")
  $cleaned = $cleaned.TrimEnd("`r", "`n")
  $final = if ([string]::IsNullOrWhiteSpace($cleaned)) { $block } else { "$cleaned`r`n`r`n$block" }
  Set-Content -Path $configFile -Value ($final + "`r`n") -NoNewline
}

$downloadRequested = Resolve-DownloadNodeJsRequested
$removeOnlyRequested = Resolve-RemoveOnlyRequested

if ($removeOnlyRequested) {
  Remove-YtGrabberRuntimeBlock
  exit 0
}

if (-not [string]::IsNullOrWhiteSpace($JsRuntimePath)) {
  if (-not (Test-Path $JsRuntimePath)) {
    throw "JavaScript runtime path not found: $JsRuntimePath"
  }
  Copy-Item $JsRuntimePath $runtimeDest -Force
} elseif ($downloadRequested) {
  Install-NodeRuntimeFromDownload
}

if (Test-Path $runtimeDest) {
  Write-YtGrabberRuntimeBlock -RuntimePath $runtimeDest
} else {
  Remove-YtGrabberRuntimeBlock
}
