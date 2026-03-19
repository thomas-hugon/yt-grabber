param(
  [Parameter(Mandatory = $true)]
  [string]$AppDir,
  [string]$InstallMode = "install",
  [string]$ResultPath = "",
  [string]$BinarySourcePath = "",
  [string]$ChecksumsSourcePath = "",
  [string]$LatestVersionOverride = "",
  [string]$ExpectedSha256Override = ""
)

$ErrorActionPreference = "Stop"
$commonPath = Join-Path $PSScriptRoot "installer-common.ps1"
. $commonPath

$mode = Resolve-InstallModeText -InstallMode $InstallMode
$destPath = Join-Path $AppDir "yt-dlp.exe"
$state = Read-InstallerState -AppDir $AppDir
$previousState = $state["ytdlp"]
$hadExistingBinary = Test-UsableFile -Path $destPath
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

  Write-InstallerResult -ResultPath $ResultPath -Component "yt-dlp" -Status $Status -Message $Message -Warning:$Warning
  $script:resultWritten = $true
}

function Find-ChecksumLine {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Content,
    [Parameter(Mandatory = $true)]
    [string[]]$Names
  )

  $lines = $Content -split "`r?`n"
  foreach ($name in $Names) {
    $escaped = [Regex]::Escape($name)
    $match = $lines | Where-Object { $_ -match ("(^|\s)" + $escaped + "$") } | Select-Object -First 1
    if ($match) {
      return $match
    }
  }

  return $null
}

function Get-LatestYtDlpMetadata {
  if (-not [string]::IsNullOrWhiteSpace($BinarySourcePath)) {
    if (-not (Test-Path $BinarySourcePath)) {
      throw "Custom yt-dlp source was not found: $BinarySourcePath"
    }

    $resolvedSha = $ExpectedSha256Override
    if ([string]::IsNullOrWhiteSpace($resolvedSha)) {
      $resolvedSha = Get-FileSha256 -Path $BinarySourcePath
    }
    if ([string]::IsNullOrWhiteSpace($resolvedSha)) {
      throw "Unable to resolve a SHA256 for the custom yt-dlp source."
    }

    $resolvedVersion = $LatestVersionOverride
    if ([string]::IsNullOrWhiteSpace($resolvedVersion)) {
      $resolvedVersion = (Get-CommandVersionString -Path $BinarySourcePath).Trim()
    }
    if ([string]::IsNullOrWhiteSpace($resolvedVersion)) {
      throw "Unable to determine the yt-dlp version for the custom source."
    }

    return [ordered]@{
      version = $resolvedVersion.Trim()
      sha256 = $resolvedSha.Trim().ToLowerInvariant()
      source = "custom-source"
      binary_path = $BinarySourcePath
      binary_url = ""
    }
  }

  $headers = @{ "User-Agent" = "YTGrabber-Installer" }
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest" -Headers $headers -UseBasicParsing
  if (-not $release.assets) {
    throw "yt-dlp latest release metadata did not include any assets."
  }

  $binaryAsset = $release.assets | Where-Object { $_.name -eq "yt-dlp.exe" } | Select-Object -First 1
  if (-not $binaryAsset) {
    throw "Unable to find yt-dlp.exe in the latest yt-dlp release."
  }

  $checksumsAsset = $release.assets | Where-Object { $_.name -eq "SHA2-256SUMS" } | Select-Object -First 1
  if (-not $checksumsAsset) {
    throw "Unable to find the SHA2-256SUMS asset in the latest yt-dlp release."
  }

  $checksumsContent = if (-not [string]::IsNullOrWhiteSpace($ChecksumsSourcePath)) {
    if (-not (Test-Path $ChecksumsSourcePath)) {
      throw "Custom yt-dlp checksum source was not found: $ChecksumsSourcePath"
    }
    Get-Content -Path $ChecksumsSourcePath -Raw
  } else {
    (Invoke-WebRequest -Uri $checksumsAsset.browser_download_url -Headers $headers -UseBasicParsing).Content
  }

  $line = Find-ChecksumLine -Content $checksumsContent -Names @("yt-dlp.exe", "yt-dlp")
  if (-not $line) {
    throw "Unable to find the yt-dlp checksum entry in SHA2-256SUMS."
  }

  $expectedSha = $ExpectedSha256Override
  if ([string]::IsNullOrWhiteSpace($expectedSha)) {
    $expectedSha = ($line -split "\s+")[0]
  }
  if ([string]::IsNullOrWhiteSpace($expectedSha)) {
    throw "Unable to resolve the expected yt-dlp checksum."
  }

  $version = if ([string]::IsNullOrWhiteSpace($LatestVersionOverride)) { [string]$release.tag_name } else { $LatestVersionOverride }
  if ([string]::IsNullOrWhiteSpace($version)) {
    throw "Unable to resolve the latest yt-dlp version."
  }

  return [ordered]@{
    version = $version.Trim()
    sha256 = $expectedSha.Trim().ToLowerInvariant()
    source = "github-release"
    binary_path = ""
    binary_url = [string]$binaryAsset.browser_download_url
  }
}

function Download-BinaryToPath {
  param(
    [Parameter(Mandatory = $true)]
    [hashtable]$Metadata,
    [Parameter(Mandatory = $true)]
    [string]$DestinationPath
  )

  if (-not [string]::IsNullOrWhiteSpace($Metadata["binary_path"])) {
    Copy-Item -Path $Metadata["binary_path"] -Destination $DestinationPath -Force
    return
  }

  Invoke-WebRequest -Uri $Metadata["binary_url"] -OutFile $DestinationPath -UseBasicParsing -Headers @{ "User-Agent" = "YTGrabber-Installer" }
}

function New-YtDlpStateSection {
  param(
    [Parameter(Mandatory = $true)]
    [hashtable]$Metadata
  )

  return [ordered]@{
    version = $Metadata["version"]
    sha256 = $Metadata["sha256"]
    source = $Metadata["source"]
  }
}

function Normalize-Version {
  param([string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return ""
  }

  return $Value.Trim()
}

try {
  $metadata = Get-LatestYtDlpMetadata
  $latestVersion = Normalize-Version -Value $metadata["version"]
  $expectedSha = $metadata["sha256"]
  $localVersion = Normalize-Version -Value (Get-CommandVersionString -Path $destPath)
  $currentStateMatches = $false

  if ($previousState -is [System.Collections.IDictionary]) {
    $stateVersion = Normalize-Version -Value $previousState["version"]
    $stateSha = Normalize-Version -Value $previousState["sha256"]
    $currentStateMatches = $hadExistingBinary -and ($stateVersion -eq $latestVersion) -and ($stateSha.ToLowerInvariant() -eq $expectedSha)
  }

  if ($currentStateMatches) {
    Write-ResultOnce -Status "kept" -Message "Kept the current yt-dlp binary; version $latestVersion is already installed."
    return
  }

  if ($hadExistingBinary -and ($localVersion -eq $latestVersion)) {
    $state["ytdlp"] = New-YtDlpStateSection -Metadata $metadata
    Write-InstallerState -AppDir $AppDir -State $state
    Write-ResultOnce -Status "kept" -Message "Kept the current yt-dlp binary and refreshed the installer state for version $latestVersion."
    return
  }

  $stagedBinary = New-InstallerTempPath -AppDir $AppDir -Name "yt-dlp.exe"
  Download-BinaryToPath -Metadata $metadata -DestinationPath $stagedBinary

  $actualSha = Get-FileSha256 -Path $stagedBinary
  if ([string]::IsNullOrWhiteSpace($actualSha)) {
    throw "The staged yt-dlp binary is missing or unreadable."
  }
  if ($actualSha -ne $expectedSha) {
    throw "yt-dlp checksum mismatch."
  }

  $stagedVersion = Normalize-Version -Value (Get-CommandVersionString -Path $stagedBinary)
  if ([string]::IsNullOrWhiteSpace($stagedVersion)) {
    throw "Unable to validate the staged yt-dlp binary."
  }
  if ($stagedVersion -ne $latestVersion) {
    throw "The staged yt-dlp version '$stagedVersion' did not match the expected version '$latestVersion'."
  }

  Replace-FileWithRollback -Source $stagedBinary -Destination $destPath
  $state["ytdlp"] = New-YtDlpStateSection -Metadata $metadata
  Write-InstallerState -AppDir $AppDir -State $state

  if ($hadExistingBinary) {
    Write-ResultOnce -Status "updated" -Message "Updated yt-dlp to version $latestVersion during this $mode."
  } else {
    Write-ResultOnce -Status "installed" -Message "Installed yt-dlp version $latestVersion during this $mode."
  }
} catch {
  $errorText = $_.Exception.Message

  if ($hadExistingBinary) {
    Write-ResultOnce -Status "kept" -Message "Failed to refresh yt-dlp during this $mode; kept the existing binary. $errorText" -Warning:$true
  } else {
    $state["ytdlp"] = $null
    Write-InstallerState -AppDir $AppDir -State $state
    Write-ResultOnce -Status "warning" -Message "Failed to install yt-dlp during this $mode; no working local binary is available. $errorText" -Warning:$true
  }
}
