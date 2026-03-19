param(
  [Parameter(Mandatory = $true)]
  [string]$AppDir,
  [string]$InstallMode = "install",
  [string]$ResultPath = "",
  [string]$ArchiveSourcePath = "",
  [string]$ChecksumsSourcePath = "",
  [string]$ReleaseIdOverride = "",
  [string]$AssetNameOverride = "",
  [string]$AssetArchOverride = "",
  [string]$ArchiveSha256Override = ""
)

$ErrorActionPreference = "Stop"
$commonPath = Join-Path $PSScriptRoot "installer-common.ps1"
. $commonPath

$mode = Resolve-InstallModeText -InstallMode $InstallMode
$ffmpegDest = Join-Path $AppDir "ffmpeg.exe"
$ffprobeDest = Join-Path $AppDir "ffprobe.exe"
$state = Read-InstallerState -AppDir $AppDir
$previousState = $state["ffmpeg"]
$hadExistingBinary = (Test-UsableFile -Path $ffmpegDest) -or (Test-UsableFile -Path $ffprobeDest)
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

  Write-InstallerResult -ResultPath $ResultPath -Component "ffmpeg" -Status $Status -Message $Message -Warning:$Warning
  $script:resultWritten = $true
}

function Resolve-WindowsAssetArch {
  if (-not [string]::IsNullOrWhiteSpace($AssetArchOverride)) {
    return $AssetArchOverride.Trim().ToLowerInvariant()
  }

  $arch = [Environment]::GetEnvironmentVariable("PROCESSOR_ARCHITECTURE", "Process")
  switch -Regex ($arch) {
    "^(AMD64|x86_64)$" { return "win64" }
    "^(ARM64|aarch64)$" { return "winarm64" }
    default { throw "Unsupported Windows architecture for FFmpeg download: $arch" }
  }
}

function Find-ReleaseAsset {
  param(
    [Parameter(Mandatory = $true)]
    [array]$Assets,
    [Parameter(Mandatory = $true)]
    [string[]]$Names
  )

  foreach ($name in $Names) {
    $match = $Assets | Where-Object { $_.name -eq $name } | Select-Object -First 1
    if ($match) {
      return $match
    }
  }

  return $null
}

function Find-ChecksumForAsset {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Content,
    [Parameter(Mandatory = $true)]
    [string]$AssetName
  )

  $escaped = [Regex]::Escape($AssetName)
  $line = ($Content -split "`r?`n") | Where-Object { $_ -match ("(^|\s)" + $escaped + "$") } | Select-Object -First 1
  if (-not $line) {
    return ""
  }

  return [string](($line -split "\s+")[0]).Trim().ToLowerInvariant()
}

function Get-LatestFfmpegMetadata {
  $assetArch = Resolve-WindowsAssetArch

  if (-not [string]::IsNullOrWhiteSpace($ArchiveSourcePath)) {
    if (-not (Test-Path $ArchiveSourcePath)) {
      throw "Custom FFmpeg archive source was not found: $ArchiveSourcePath"
    }

    $resolvedSha = $ArchiveSha256Override
    if ([string]::IsNullOrWhiteSpace($resolvedSha)) {
      $resolvedSha = Get-FileSha256 -Path $ArchiveSourcePath
    }
    if ([string]::IsNullOrWhiteSpace($resolvedSha)) {
      throw "Unable to resolve a SHA256 for the custom FFmpeg archive."
    }

    $assetName = $AssetNameOverride
    if ([string]::IsNullOrWhiteSpace($assetName)) {
      $assetName = Split-Path -Path $ArchiveSourcePath -Leaf
    }

    $releaseId = $ReleaseIdOverride
    if ([string]::IsNullOrWhiteSpace($releaseId)) {
      $releaseId = "custom"
    }

    return [ordered]@{
      release_id = [string]$releaseId
      asset_name = [string]$assetName
      asset_arch = [string]$assetArch
      archive_sha256 = $resolvedSha.Trim().ToLowerInvariant()
      archive_path = $ArchiveSourcePath
      archive_url = ""
      source = "custom-source"
    }
  }

  $headers = @{ "User-Agent" = "YTGrabber-Installer" }
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest" -Headers $headers -UseBasicParsing
  if (-not $release.assets) {
    throw "FFmpeg latest release metadata did not include any assets."
  }

  $preferredNames = @(
    "ffmpeg-master-latest-$assetArch-lgpl.zip",
    "ffmpeg-master-latest-$assetArch-lgpl-shared.zip",
    "ffmpeg-n8.0-latest-$assetArch-lgpl-8.0.zip",
    "ffmpeg-n8.0-latest-$assetArch-lgpl-shared-8.0.zip",
    "ffmpeg-n7.1-latest-$assetArch-lgpl-7.1.zip",
    "ffmpeg-n7.1-latest-$assetArch-lgpl-shared-7.1.zip"
  )

  $archiveAsset = Find-ReleaseAsset -Assets $release.assets -Names $preferredNames
  if (-not $archiveAsset) {
    $available = ($release.assets | Where-Object { $_.name -like "ffmpeg-*-$assetArch-*.zip" } | Select-Object -ExpandProperty name) -join ", "
    throw "Unable to find a supported FFmpeg asset for $assetArch. Available assets: $available"
  }

  $archiveSha = $ArchiveSha256Override
  if ([string]::IsNullOrWhiteSpace($archiveSha)) {
    $checksumsContent = if (-not [string]::IsNullOrWhiteSpace($ChecksumsSourcePath)) {
      if (-not (Test-Path $ChecksumsSourcePath)) {
        throw "Custom FFmpeg checksum source was not found: $ChecksumsSourcePath"
      }
      Get-Content -Path $ChecksumsSourcePath -Raw
    } else {
      $checksumsAsset = $release.assets | Where-Object { $_.name -eq "checksums.sha256" } | Select-Object -First 1
      if (-not $checksumsAsset) {
        throw "Unable to find the FFmpeg checksums.sha256 asset."
      }
      (Invoke-WebRequest -Uri $checksumsAsset.browser_download_url -Headers $headers -UseBasicParsing).Content
    }

    $archiveSha = Find-ChecksumForAsset -Content $checksumsContent -AssetName $archiveAsset.name
  }

  if ([string]::IsNullOrWhiteSpace($archiveSha)) {
    throw "Unable to resolve the expected FFmpeg archive checksum for $($archiveAsset.name)."
  }

  return [ordered]@{
    release_id = [string]$release.id
    asset_name = [string]$archiveAsset.name
    asset_arch = [string]$assetArch
    archive_sha256 = $archiveSha.Trim().ToLowerInvariant()
    archive_path = ""
    archive_url = [string]$archiveAsset.browser_download_url
    source = "github-release"
  }
}

function Download-ArchiveToPath {
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

  Invoke-WebRequest -Uri $Metadata["archive_url"] -OutFile $DestinationPath -UseBasicParsing -Headers @{ "User-Agent" = "YTGrabber-Installer" }
}

function New-FfmpegStateSection {
  param(
    [Parameter(Mandatory = $true)]
    [hashtable]$Metadata
  )

  return [ordered]@{
    release_id = $Metadata["release_id"]
    asset_name = $Metadata["asset_name"]
    asset_arch = $Metadata["asset_arch"]
    archive_sha256 = $Metadata["archive_sha256"]
    source = $Metadata["source"]
  }
}

function Normalize-Text {
  param($Value)

  if ($null -eq $Value) {
    return ""
  }

  return [string]$Value
}

try {
  $metadata = Get-LatestFfmpegMetadata
  $hasUsablePair = (Test-UsableFile -Path $ffmpegDest) -and (Test-UsableFile -Path $ffprobeDest)
  $currentStateMatches = $false

  if (($previousState -is [hashtable]) -and $hasUsablePair) {
    $stateReleaseId = Normalize-Text $previousState["release_id"]
    $stateAssetName = Normalize-Text $previousState["asset_name"]
    $stateArch = Normalize-Text $previousState["asset_arch"]
    $stateArchiveSha = Normalize-Text $previousState["archive_sha256"]
    $currentStateMatches = ($stateReleaseId -eq (Normalize-Text $metadata["release_id"])) `
      -and ($stateAssetName -eq (Normalize-Text $metadata["asset_name"])) `
      -and ($stateArch -eq (Normalize-Text $metadata["asset_arch"])) `
      -and ($stateArchiveSha.ToLowerInvariant() -eq (Normalize-Text $metadata["archive_sha256"]))
  }

  if ($currentStateMatches) {
    Write-ResultOnce -Status "kept" -Message "Kept the current FFmpeg binaries; asset $($metadata['asset_name']) is already installed."
    return
  }

  $archiveTempPath = New-InstallerTempPath -AppDir $AppDir -Name $metadata["asset_name"]
  $extractDir = New-InstallerTempPath -AppDir $AppDir -Name "ffmpeg-extract"

  try {
    Download-ArchiveToPath -Metadata $metadata -DestinationPath $archiveTempPath

    $actualSha = Get-FileSha256 -Path $archiveTempPath
    if ([string]::IsNullOrWhiteSpace($actualSha)) {
      throw "The staged FFmpeg archive is missing or unreadable."
    }
    if ($actualSha -ne $metadata["archive_sha256"]) {
      throw "FFmpeg archive checksum mismatch for $($metadata['asset_name'])."
    }

    Expand-Archive -Path $archiveTempPath -DestinationPath $extractDir -Force

    $ffmpegFound = Get-ChildItem -Path $extractDir -Filter "ffmpeg.exe" -Recurse | Select-Object -First 1
    if (-not $ffmpegFound) {
      throw "ffmpeg.exe was not found in the extracted archive."
    }

    $ffprobeFound = Get-ChildItem -Path $extractDir -Filter "ffprobe.exe" -Recurse | Select-Object -First 1
    if (-not $ffprobeFound) {
      throw "ffprobe.exe was not found in the extracted archive."
    }

    $stagedFfmpeg = New-InstallerTempPath -AppDir $AppDir -Name "ffmpeg.exe"
    $stagedFfprobe = New-InstallerTempPath -AppDir $AppDir -Name "ffprobe.exe"
    Copy-Item -Path $ffmpegFound.FullName -Destination $stagedFfmpeg -Force
    Copy-Item -Path $ffprobeFound.FullName -Destination $stagedFfprobe -Force

    if (-not (Test-UsableFile -Path $stagedFfmpeg)) {
      throw "The staged ffmpeg.exe binary is invalid."
    }
    if (-not (Test-UsableFile -Path $stagedFfprobe)) {
      throw "The staged ffprobe.exe binary is invalid."
    }

    Replace-FileSetWithRollback -Pairs @(
      @{ Source = $stagedFfmpeg; Destination = $ffmpegDest },
      @{ Source = $stagedFfprobe; Destination = $ffprobeDest }
    )
  } finally {
    Remove-Item -Path $archiveTempPath -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $extractDir -Recurse -Force -ErrorAction SilentlyContinue
  }

  $state["ffmpeg"] = New-FfmpegStateSection -Metadata $metadata
  Write-InstallerState -AppDir $AppDir -State $state

  if ($hadExistingBinary) {
    Write-ResultOnce -Status "updated" -Message "Updated FFmpeg to asset $($metadata['asset_name']) during this $mode."
  } else {
    Write-ResultOnce -Status "installed" -Message "Installed FFmpeg asset $($metadata['asset_name']) during this $mode."
  }
} catch {
  $errorText = $_.Exception.Message

  if ($hadExistingBinary) {
    Write-ResultOnce -Status "kept" -Message "Failed to refresh FFmpeg during this $mode; kept the existing local binaries. $errorText" -Warning:$true
  } else {
    $state["ffmpeg"] = $null
    Write-InstallerState -AppDir $AppDir -State $state
    Write-ResultOnce -Status "warning" -Message "Failed to install FFmpeg during this $mode; no working local ffmpeg.exe/ffprobe.exe pair is available. $errorText" -Warning:$true
  }
}
