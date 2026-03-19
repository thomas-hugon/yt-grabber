param(
  [Parameter(Mandatory = $true)]
  [string]$AppDir,
  [string]$InstallMode = "install",
  [string]$JsRuntimePath = "",
  [string]$DownloadNodeJs = "",
  [string]$RemoveOnly = "",
  [string]$ResultPath = "",
  [string]$ConfigDirOverride = "",
  [string]$NodeArchiveSourcePath = "",
  [string]$NodeArchiveSha256Override = "",
  [string]$LatestNodeVersionOverride = "",
  [string]$NodeArchiveKindOverride = ""
)

$ErrorActionPreference = "Stop"
$commonPath = Join-Path $PSScriptRoot "installer-common.ps1"
. $commonPath

$mode = Resolve-InstallModeText -InstallMode $InstallMode
$runtimeDest = Join-Path $AppDir "ytg-nodejs.exe"
$configDir = if ([string]::IsNullOrWhiteSpace($ConfigDirOverride)) { Join-Path $env:APPDATA "yt-dlp" } else { $ConfigDirOverride }
$configFile = Join-Path $configDir "config"
$markerStart = "# BEGIN YTGRABBER JS RUNTIME"
$markerEnd = "# END YTGRABBER JS RUNTIME"
$state = Read-InstallerState -AppDir $AppDir
$previousState = $state["node"]
$downloadRequested = Resolve-BooleanFlag -Value $DownloadNodeJs
$removeOnlyRequested = Resolve-BooleanFlag -Value $RemoveOnly
$resultWritten = $false

function Write-ResultOnce {
  param(
    [string]$Status,
    [string]$Message,
    [bool]$Warning = $false
  )

  if ($resultWritten) {
    return
  }

  Write-InstallerResult -ResultPath $ResultPath -Component "node-runtime" -Status $Status -Message $Message -Warning:$Warning
  $script:resultWritten = $true
}

function Test-YtGrabberRuntimeBlockPresent {
  if (-not (Test-Path $configFile)) {
    return $false
  }

  try {
    $raw = Get-Content -Path $configFile -Raw
    return $raw.Contains($markerStart) -and $raw.Contains($markerEnd)
  } catch {
    return $false
  }
}

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
    Remove-Item -Path $configFile -Force -ErrorAction SilentlyContinue
    return
  }

  Write-TextFileUtf8NoBom -Path $configFile -Content ($updated + "`r`n")
}

function Write-YtGrabberRuntimeBlock {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RuntimePath
  )

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
  Write-TextFileUtf8NoBom -Path $configFile -Content ($final + "`r`n")
}

function Resolve-NodeArchiveKind {
  if (-not [string]::IsNullOrWhiteSpace($NodeArchiveKindOverride)) {
    return $NodeArchiveKindOverride.Trim().ToLowerInvariant()
  }

  $arch = [Environment]::GetEnvironmentVariable("PROCESSOR_ARCHITECTURE", "Process")
  switch -Regex ($arch) {
    "^(AMD64|x86_64)$" { return "win-x64-zip" }
    "^(ARM64|aarch64)$" { return "win-arm64-zip" }
    default { throw "Unsupported Windows architecture for Node.js download: $arch" }
  }
}

function Get-ValidatedNodeVersion {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RuntimePath
  )

  if (-not (Test-UsableFile -Path $RuntimePath)) {
    return ""
  }

  try {
    $output = & $RuntimePath --version 2>$null
    if ($LASTEXITCODE -ne 0) {
      return ""
    }

    $version = if ($output -is [System.Array]) { [string]($output | Select-Object -First 1) } else { [string]$output }
    $version = $version.Trim()
    if ($version -notmatch '^v\d+\.\d+\.\d+$') {
      return ""
    }

    return $version
  } catch {
    return ""
  }
}

function Assert-NodeRuntimeBinary {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RuntimePath
  )

  if (-not (Test-UsableFile -Path $RuntimePath)) {
    throw "JavaScript runtime not found after installation: $RuntimePath"
  }

  $version = Get-ValidatedNodeVersion -RuntimePath $RuntimePath
  if ([string]::IsNullOrWhiteSpace($version)) {
    throw "JavaScript runtime validation failed for $RuntimePath"
  }

  return $version
}

function New-NodeStateSection {
  param(
    [string]$Version,
    [string]$Sha256,
    [string]$Source,
    [string]$ArchiveKind
  )

  return [ordered]@{
    managed = $true
    version = $Version
    sha256 = $Sha256
    source = $Source
    archive_kind = $ArchiveKind
  }
}

function Download-NodeArchiveToPath {
  param(
    [Parameter(Mandatory = $true)]
    [hashtable]$Metadata,
    [Parameter(Mandatory = $true)]
    [string]$DestinationPath
  )

  if (-not [string]::IsNullOrWhiteSpace($Metadata["archive_path"])) {
    Copy-Item -Path $Metadata["archive_path"] -Destination $DestinationPath -Force
    return
  }

  Invoke-WebRequest -Uri $Metadata["archive_url"] -OutFile $DestinationPath -UseBasicParsing
}

function Get-LatestNodeMetadata {
  $archiveKind = Resolve-NodeArchiveKind

  if (-not [string]::IsNullOrWhiteSpace($NodeArchiveSourcePath)) {
    if (-not (Test-Path $NodeArchiveSourcePath)) {
      throw "Custom Node.js archive source was not found: $NodeArchiveSourcePath"
    }
    if ([string]::IsNullOrWhiteSpace($LatestNodeVersionOverride)) {
      throw "LatestNodeVersionOverride is required when using NodeArchiveSourcePath."
    }

    $resolvedSha = $NodeArchiveSha256Override
    if ([string]::IsNullOrWhiteSpace($resolvedSha)) {
      $resolvedSha = Get-FileSha256 -Path $NodeArchiveSourcePath
    }
    if ([string]::IsNullOrWhiteSpace($resolvedSha)) {
      throw "Unable to resolve a SHA256 for the custom Node.js archive."
    }

    return [ordered]@{
      version = $LatestNodeVersionOverride.Trim()
      archive_kind = $archiveKind
      archive_sha256 = $resolvedSha.Trim().ToLowerInvariant()
      archive_name = Split-Path -Path $NodeArchiveSourcePath -Leaf
      archive_path = $NodeArchiveSourcePath
      archive_url = ""
      source = "custom-source"
    }
  }

  $index = Invoke-WebRequest -Uri "https://nodejs.org/dist/index.json" -UseBasicParsing | Select-Object -ExpandProperty Content | ConvertFrom-Json
  $release = $index | Where-Object { $_.lts -and $_.files -contains $archiveKind } | Select-Object -First 1
  if (-not $release) {
    throw "Unable to find an LTS Node.js release for $archiveKind."
  }

  $version = if ([string]::IsNullOrWhiteSpace($LatestNodeVersionOverride)) { [string]$release.version } else { $LatestNodeVersionOverride }
  if ([string]::IsNullOrWhiteSpace($version)) {
    throw "Unable to resolve the latest Node.js version."
  }

  $archiveName = "node-$version-$archiveKind.zip"
  $baseUrl = "https://nodejs.org/dist/$version"
  $expectedSha = $NodeArchiveSha256Override
  if ([string]::IsNullOrWhiteSpace($expectedSha)) {
    $checksumsContent = (Invoke-WebRequest -Uri "$baseUrl/SHASUMS256.txt" -UseBasicParsing).Content
    $escaped = [Regex]::Escape($archiveName)
    $line = ($checksumsContent -split "`r?`n") | Where-Object { $_ -match ("(^|\s)" + $escaped + "$") } | Select-Object -First 1
    if (-not $line) {
      throw "Unable to find the checksum entry for $archiveName."
    }

    $expectedSha = [string](($line -split "\s+")[0]).Trim().ToLowerInvariant()
  }

  return [ordered]@{
    version = $version.Trim()
    archive_kind = $archiveKind
    archive_sha256 = $expectedSha.Trim().ToLowerInvariant()
    archive_name = $archiveName
    archive_path = ""
    archive_url = "$baseUrl/$archiveName"
    source = "download"
  }
}

if ($removeOnlyRequested) {
  Remove-YtGrabberRuntimeBlock
  exit 0
}

try {
  $staleBlockPresent = Test-YtGrabberRuntimeBlockPresent
  $existingManagedVersion = Get-ValidatedNodeVersion -RuntimePath $runtimeDest
  $managedExisting = -not [string]::IsNullOrWhiteSpace($existingManagedVersion)

  if (-not [string]::IsNullOrWhiteSpace($JsRuntimePath)) {
    if (-not (Test-Path $JsRuntimePath)) {
      throw "JavaScript runtime path not found: $JsRuntimePath"
    }

    $stagedRuntime = New-InstallerTempPath -AppDir $AppDir -Name "ytg-nodejs.exe"
    Copy-Item -Path $JsRuntimePath -Destination $stagedRuntime -Force

    $stagedVersion = Assert-NodeRuntimeBinary -RuntimePath $stagedRuntime
    $stagedSha = Get-FileSha256 -Path $stagedRuntime
    $existingSha = Get-FileSha256 -Path $runtimeDest

    if ($managedExisting -and ($existingSha -eq $stagedSha)) {
      Remove-Item -Path $stagedRuntime -Force -ErrorAction SilentlyContinue
      Write-YtGrabberRuntimeBlock -RuntimePath $runtimeDest
      $state["node"] = New-NodeStateSection -Version $stagedVersion -Sha256 $stagedSha -Source "explicit-path" -ArchiveKind "explicit-path"
      Write-InstallerState -AppDir $AppDir -State $state
      Write-ResultOnce -Status "kept" -Message "Kept the existing managed Node.js runtime from the explicit override path."
      return
    }

    Replace-FileWithRollback -Source $stagedRuntime -Destination $runtimeDest
    Write-YtGrabberRuntimeBlock -RuntimePath $runtimeDest
    $state["node"] = New-NodeStateSection -Version $stagedVersion -Sha256 $stagedSha -Source "explicit-path" -ArchiveKind "explicit-path"
    Write-InstallerState -AppDir $AppDir -State $state

    if ($managedExisting) {
      Write-ResultOnce -Status "updated" -Message "Updated the managed Node.js runtime from the explicit override path."
    } else {
      Write-ResultOnce -Status "installed" -Message "Installed the managed Node.js runtime from the explicit override path."
    }
    return
  }

  if (-not $downloadRequested -and -not $managedExisting -and -not (Test-UsableFile -Path $runtimeDest)) {
    if ($staleBlockPresent) {
      Remove-YtGrabberRuntimeBlock
    }
    $state["node"] = $null
    Write-InstallerState -AppDir $AppDir -State $state
    Write-ResultOnce -Status "skipped" -Message "No YT Grabber-managed Node.js runtime is configured; left external yt-dlp JavaScript settings unchanged."
    return
  }

  try {
    $metadata = Get-LatestNodeMetadata
  } catch {
    $errorText = $_.Exception.Message
    if ($managedExisting) {
      Write-YtGrabberRuntimeBlock -RuntimePath $runtimeDest
      Write-ResultOnce -Status "kept" -Message "Failed to resolve the latest managed Node.js runtime during this $mode; kept the existing runtime. $errorText" -Warning:$true
      return
    }

    $state["node"] = $null
    Write-InstallerState -AppDir $AppDir -State $state
    Remove-YtGrabberRuntimeBlock
    Write-ResultOnce -Status "warning" -Message "Failed to configure a managed Node.js runtime during this $mode, and no existing managed runtime is available. $errorText" -Warning:$true
    return
  }

  $stateMatches = $false
  if (($previousState -is [hashtable]) -and $managedExisting) {
    $stateVersion = [string]$previousState["version"]
    $stateArchiveKind = [string]$previousState["archive_kind"]
    $stateSha = [string]$previousState["sha256"]
    $stateManaged = [bool]$previousState["managed"]
    $stateMatches = $stateManaged `
      -and ($stateVersion -eq $metadata["version"]) `
      -and ($stateArchiveKind -eq $metadata["archive_kind"]) `
      -and ($stateSha.ToLowerInvariant() -eq $metadata["archive_sha256"])
  }

  if ($stateMatches) {
    Write-YtGrabberRuntimeBlock -RuntimePath $runtimeDest
    Write-ResultOnce -Status "kept" -Message "Kept the current managed Node.js runtime; version $($metadata['version']) is already installed."
    return
  }

  if ($managedExisting -and ($existingManagedVersion -eq $metadata["version"])) {
    Write-YtGrabberRuntimeBlock -RuntimePath $runtimeDest
    $state["node"] = New-NodeStateSection -Version $metadata["version"] -Sha256 $metadata["archive_sha256"] -Source $metadata["source"] -ArchiveKind $metadata["archive_kind"]
    Write-InstallerState -AppDir $AppDir -State $state
    Write-ResultOnce -Status "kept" -Message "Kept the current managed Node.js runtime and refreshed the installer state for version $($metadata['version'])."
    return
  }

  $archiveTempPath = New-InstallerTempPath -AppDir $AppDir -Name $metadata["archive_name"]
  $extractDir = New-InstallerTempPath -AppDir $AppDir -Name "nodejs-extract"

  try {
    Download-NodeArchiveToPath -Metadata $metadata -DestinationPath $archiveTempPath

    $archiveSha = Get-FileSha256 -Path $archiveTempPath
    if ([string]::IsNullOrWhiteSpace($archiveSha)) {
      throw "The staged Node.js archive is missing or unreadable."
    }
    if ($archiveSha -ne $metadata["archive_sha256"]) {
      throw "Node.js archive checksum mismatch for $($metadata['archive_name'])."
    }

    Expand-Archive -Path $archiveTempPath -DestinationPath $extractDir -Force
    $nodeExe = Get-ChildItem -Path $extractDir -Filter "node.exe" -Recurse | Select-Object -First 1
    if (-not $nodeExe) {
      throw "node.exe was not found in the extracted archive."
    }

    $stagedRuntime = New-InstallerTempPath -AppDir $AppDir -Name "ytg-nodejs.exe"
    Copy-Item -Path $nodeExe.FullName -Destination $stagedRuntime -Force
    $stagedVersion = Assert-NodeRuntimeBinary -RuntimePath $stagedRuntime
    if ($stagedVersion -ne $metadata["version"]) {
      throw "The staged Node.js version '$stagedVersion' did not match the expected version '$($metadata['version'])'."
    }

    Replace-FileWithRollback -Source $stagedRuntime -Destination $runtimeDest
    Write-YtGrabberRuntimeBlock -RuntimePath $runtimeDest
    $state["node"] = New-NodeStateSection -Version $metadata["version"] -Sha256 $metadata["archive_sha256"] -Source $metadata["source"] -ArchiveKind $metadata["archive_kind"]
    Write-InstallerState -AppDir $AppDir -State $state

    if ($managedExisting) {
      Write-ResultOnce -Status "updated" -Message "Updated the managed Node.js runtime to version $($metadata['version']) during this $mode."
    } else {
      Write-ResultOnce -Status "installed" -Message "Installed the managed Node.js runtime version $($metadata['version']) during this $mode."
    }
  } finally {
    Remove-Item -Path $archiveTempPath -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $extractDir -Recurse -Force -ErrorAction SilentlyContinue
  }
} catch {
  $errorText = $_.Exception.Message
  $existingManagedVersion = Get-ValidatedNodeVersion -RuntimePath $runtimeDest
  if (-not [string]::IsNullOrWhiteSpace($existingManagedVersion)) {
    Write-YtGrabberRuntimeBlock -RuntimePath $runtimeDest
    Write-ResultOnce -Status "kept" -Message "Failed to refresh the managed Node.js runtime during this $mode; kept the existing runtime. $errorText" -Warning:$true
  } else {
    Remove-YtGrabberRuntimeBlock
    $state["node"] = $null
    Write-InstallerState -AppDir $AppDir -State $state
    Write-ResultOnce -Status "warning" -Message "Failed to configure a managed Node.js runtime during this $mode, and no working managed runtime is available. $errorText" -Warning:$true
  }
}
