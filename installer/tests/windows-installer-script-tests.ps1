Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$installerDir = Join-Path $repoRoot "installer"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ytg-installer-tests-" + [Guid]::NewGuid().ToString("N"))
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
New-Item -ItemType Directory -Path $tempRoot | Out-Null

function Fail-Test {
  param([string]$Message)

  throw $Message
}

function Assert-True {
  param(
    [bool]$Condition,
    [string]$Message
  )

  if (-not $Condition) {
    Fail-Test $Message
  }
}

function Assert-Equal {
  param(
    $Expected,
    $Actual,
    [string]$Message
  )

  if ($Expected -ne $Actual) {
    Fail-Test ($Message + " Expected '$Expected' but got '$Actual'.")
  }
}

function New-TestDir {
  param([string]$Name)

  $path = Join-Path $tempRoot $Name
  New-Item -ItemType Directory -Path $path -Force | Out-Null
  return $path
}

function Get-ResultValue {
  param(
    [string]$Path,
    [string]$Key
  )

  $line = Get-Content -Path $Path | Where-Object { $_ -like "$Key=*" } | Select-Object -First 1
  if (-not $line) {
    return ""
  }

  return $line.Substring($Key.Length + 1)
}

function Read-Result {
  param([string]$Path)

  if (-not (Test-Path $Path)) {
    Fail-Test "Missing result file: $Path"
  }

  return [ordered]@{
    component = Get-ResultValue -Path $Path -Key "component"
    status = Get-ResultValue -Path $Path -Key "status"
    warning = Get-ResultValue -Path $Path -Key "warning"
    message = Get-ResultValue -Path $Path -Key "message"
  }
}

function Write-StateFile {
  param(
    [string]$AppDir,
    [hashtable]$State
  )

  $path = Join-Path $AppDir "ytgrabber-installer-state.json"
  [System.IO.File]::WriteAllText($path, ($State | ConvertTo-Json -Depth 8) + "`r`n", $utf8NoBom)
}

function Invoke-InstallerScript {
  param(
    [string]$ScriptName,
    [hashtable]$Arguments
  )

  $argList = @(
    "-NoProfile"
    "-ExecutionPolicy"
    "Bypass"
    "-File"
    (Join-Path $installerDir $ScriptName)
  )

  foreach ($entry in $Arguments.GetEnumerator()) {
    $argList += "-$($entry.Key)"
    $argList += [string]$entry.Value
  }

  & powershell.exe @argList
  if ($LASTEXITCODE -ne 0) {
    Fail-Test ("Installer script exited with code " + $LASTEXITCODE + ": " + $ScriptName)
  }
}

function New-ZipFixture {
  param(
    [string]$FixtureName,
    [hashtable]$Files
  )

  $fixtureDir = New-TestDir -Name ("fixture-" + $FixtureName)
  foreach ($entry in $Files.GetEnumerator()) {
    Copy-Item -Path $entry.Value -Destination (Join-Path $fixtureDir $entry.Key) -Force
  }

  $zipPath = Join-Path $tempRoot ($FixtureName + ".zip")
  if (Test-Path $zipPath) {
    Remove-Item -Path $zipPath -Force
  }
  Compress-Archive -Path (Join-Path $fixtureDir '*') -DestinationPath $zipPath -Force
  return $zipPath
}

function Test-WriteTokenPreservesExisting {
  $appDir = New-TestDir -Name "write-token-preserve"
  $resultPath = Join-Path $appDir "result.ini"
  $token = ("ab" * 32)
  [System.IO.File]::WriteAllText((Join-Path $appDir "ytgrabber.token"), $token, $utf8NoBom)

  Invoke-InstallerScript -ScriptName "write-token.ps1" -Arguments @{
    AppDir = $appDir
    InstallMode = "update"
    ResultPath = $resultPath
  }

  $storedToken = (Get-Content -Path (Join-Path $appDir "ytgrabber.token") -Raw)
  $result = Read-Result -Path $resultPath
  Assert-Equal $token $storedToken "write-token should preserve the existing token."
  Assert-Equal "kept" $result.status "write-token should report a kept status."
  Assert-Equal "0" $result.warning "write-token should not warn when preserving a token."
}

function Test-YtDlpStateSkip {
  param(
    [string]$NodeExePath,
    [string]$NodeVersion,
    [string]$NodeSha
  )

  $appDir = New-TestDir -Name "ytdlp-skip"
  $binaryPath = Join-Path $appDir "yt-dlp.exe"
  $resultPath = Join-Path $appDir "result.ini"
  Copy-Item -Path $NodeExePath -Destination $binaryPath -Force

  Write-StateFile -AppDir $appDir -State ([ordered]@{
      schema_version = 1
      ytdlp = [ordered]@{
        version = $NodeVersion
        sha256 = $NodeSha
        source = "custom-source"
      }
      ffmpeg = $null
      node = $null
    })

  Invoke-InstallerScript -ScriptName "download-yt-dlp.ps1" -Arguments @{
    AppDir = $appDir
    InstallMode = "update"
    ResultPath = $resultPath
    BinarySourcePath = $NodeExePath
    LatestVersionOverride = $NodeVersion
    ExpectedSha256Override = $NodeSha
  }

  $result = Read-Result -Path $resultPath
  Assert-Equal "kept" $result.status "yt-dlp should skip when the managed state already matches."
  Assert-Equal "0" $result.warning "yt-dlp skip should not warn."
}

function Test-YtDlpFailureKeepsExisting {
  param([string]$NodeExePath)

  $appDir = New-TestDir -Name "ytdlp-failure-keep"
  $binaryPath = Join-Path $appDir "yt-dlp.exe"
  $resultPath = Join-Path $appDir "result.ini"
  Copy-Item -Path $NodeExePath -Destination $binaryPath -Force

  Invoke-InstallerScript -ScriptName "download-yt-dlp.ps1" -Arguments @{
    AppDir = $appDir
    InstallMode = "update"
    ResultPath = $resultPath
    BinarySourcePath = (Join-Path $appDir "missing-source.exe")
    LatestVersionOverride = "v0.0.0"
  }

  $result = Read-Result -Path $resultPath
  Assert-Equal "kept" $result.status "yt-dlp refresh failures should keep the existing binary."
  Assert-Equal "1" $result.warning "yt-dlp refresh failures should be warnings."
  Assert-True (Test-Path $binaryPath) "Existing yt-dlp binary should still exist after a failed refresh."
}

function Test-FfmpegStateSkip {
  param(
    [string]$NodeExePath,
    [string]$ArchivePath,
    [string]$ArchiveSha
  )

  $appDir = New-TestDir -Name "ffmpeg-skip"
  $resultPath = Join-Path $appDir "result.ini"
  Copy-Item -Path $NodeExePath -Destination (Join-Path $appDir "ffmpeg.exe") -Force
  Copy-Item -Path $NodeExePath -Destination (Join-Path $appDir "ffprobe.exe") -Force

  Write-StateFile -AppDir $appDir -State ([ordered]@{
      schema_version = 1
      ytdlp = $null
      ffmpeg = [ordered]@{
        release_id = "fixture-release"
        asset_name = "fixture-ffmpeg.zip"
        asset_arch = "win64"
        archive_sha256 = $ArchiveSha
        source = "custom-source"
      }
      node = $null
    })

  Invoke-InstallerScript -ScriptName "download-ffmpeg.ps1" -Arguments @{
    AppDir = $appDir
    InstallMode = "update"
    ResultPath = $resultPath
    ArchiveSourcePath = $ArchivePath
    ReleaseIdOverride = "fixture-release"
    AssetNameOverride = "fixture-ffmpeg.zip"
    AssetArchOverride = "win64"
    ArchiveSha256Override = $ArchiveSha
  }

  $result = Read-Result -Path $resultPath
  Assert-Equal "kept" $result.status "FFmpeg should skip when the managed state already matches."
  Assert-Equal "0" $result.warning "FFmpeg skip should not warn."
}

function Test-FfmpegFailureKeepsExisting {
  param([string]$NodeExePath)

  $appDir = New-TestDir -Name "ffmpeg-failure-keep"
  $resultPath = Join-Path $appDir "result.ini"
  $ffmpegPath = Join-Path $appDir "ffmpeg.exe"
  $ffprobePath = Join-Path $appDir "ffprobe.exe"
  Copy-Item -Path $NodeExePath -Destination $ffmpegPath -Force
  Copy-Item -Path $NodeExePath -Destination $ffprobePath -Force

  Invoke-InstallerScript -ScriptName "download-ffmpeg.ps1" -Arguments @{
    AppDir = $appDir
    InstallMode = "update"
    ResultPath = $resultPath
    ArchiveSourcePath = (Join-Path $appDir "missing-ffmpeg.zip")
    ReleaseIdOverride = "fixture-release"
    AssetNameOverride = "fixture-ffmpeg.zip"
    AssetArchOverride = "win64"
  }

  $result = Read-Result -Path $resultPath
  Assert-Equal "kept" $result.status "FFmpeg refresh failures should keep the existing binaries."
  Assert-Equal "1" $result.warning "FFmpeg refresh failures should be warnings."
  Assert-True (Test-Path $ffmpegPath) "Existing ffmpeg.exe should still exist after a failed refresh."
  Assert-True (Test-Path $ffprobePath) "Existing ffprobe.exe should still exist after a failed refresh."
}

function Test-NodeRuntimeSkippedWhenUnmanaged {
  $appDir = New-TestDir -Name "node-skip-unmanaged"
  $configDir = New-TestDir -Name "node-skip-config"
  $resultPath = Join-Path $appDir "result.ini"
  $configPath = Join-Path $configDir "config"
  [System.IO.File]::WriteAllText($configPath, "--verbose`r`n", $utf8NoBom)

  Invoke-InstallerScript -ScriptName "configure-ytdlp-runtime.ps1" -Arguments @{
    AppDir = $appDir
    InstallMode = "update"
    ResultPath = $resultPath
    ConfigDirOverride = $configDir
  }

  $result = Read-Result -Path $resultPath
  Assert-Equal "skipped" $result.status "Node runtime should be skipped when nothing is managed and no flags are passed."
  Assert-Equal "--verbose" ((Get-Content -Path $configPath -Raw).Trim()) "External yt-dlp config should remain unchanged."
}

function Test-NodeRuntimeInstallFromExplicitPath {
  param(
    [string]$NodeExePath,
    [string]$NodeVersion
  )

  $appDir = New-TestDir -Name "node-explicit-install"
  $configDir = New-TestDir -Name "node-explicit-config"
  $resultPath = Join-Path $appDir "result.ini"

  Invoke-InstallerScript -ScriptName "configure-ytdlp-runtime.ps1" -Arguments @{
    AppDir = $appDir
    InstallMode = "install"
    ResultPath = $resultPath
    ConfigDirOverride = $configDir
    JsRuntimePath = $NodeExePath
  }

  $runtimeDest = Join-Path $appDir "ytg-nodejs.exe"
  $configPath = Join-Path $configDir "config"
  $result = Read-Result -Path $resultPath
  $statePath = Join-Path $appDir "ytgrabber-installer-state.json"
  $state = Get-Content -Path $statePath -Raw | ConvertFrom-Json

  Assert-Equal "installed" $result.status "Explicit Node.js runtime install should report installed."
  Assert-True (Test-Path $runtimeDest) "Managed node runtime should be copied into the app dir."
  Assert-True ((Get-Content -Path $configPath -Raw) -match [regex]::Escape("# BEGIN YTGRABBER JS RUNTIME")) "Config file should contain the YT Grabber runtime block."
  Assert-Equal $NodeVersion ([string]$state.node.version) "Managed node runtime state should record the installed version."
}

function Test-NodeRuntimeFailureKeepsManaged {
  param([string]$NodeExePath)

  $appDir = New-TestDir -Name "node-failure-keep"
  $configDir = New-TestDir -Name "node-failure-config"
  $resultPath = Join-Path $appDir "result.ini"
  $runtimeDest = Join-Path $appDir "ytg-nodejs.exe"
  Copy-Item -Path $NodeExePath -Destination $runtimeDest -Force

  Invoke-InstallerScript -ScriptName "configure-ytdlp-runtime.ps1" -Arguments @{
    AppDir = $appDir
    InstallMode = "update"
    ResultPath = $resultPath
    ConfigDirOverride = $configDir
    NodeArchiveSourcePath = (Join-Path $appDir "missing-node.zip")
    LatestNodeVersionOverride = "v0.0.0"
  }

  $configPath = Join-Path $configDir "config"
  $result = Read-Result -Path $resultPath
  Assert-Equal "kept" $result.status "Managed Node.js refresh failures should keep the existing runtime."
  Assert-Equal "1" $result.warning "Managed Node.js refresh failures should be warnings."
  Assert-True (Test-Path $runtimeDest) "Existing managed node runtime should still exist after a failed refresh."
  Assert-True ((Get-Content -Path $configPath -Raw) -match [regex]::Escape("# BEGIN YTGRABBER JS RUNTIME")) "Managed runtime config block should be restored when keeping the existing runtime."
}

function Test-StartupTaskMissingServerWarns {
  $appDir = New-TestDir -Name "startup-task-warning"
  $resultPath = Join-Path $appDir "result.ini"

  Invoke-InstallerScript -ScriptName "register-startup-task.ps1" -Arguments @{
    AppDir = $appDir
    InstallMode = "install"
    ResultPath = $resultPath
  }

  $result = Read-Result -Path $resultPath
  Assert-Equal "warning" $result.status "Startup-task registration should warn when the server executable is missing."
  Assert-Equal "1" $result.warning "Missing startup-task registration should be a warning."
}

try {
  $nodeCommand = Get-Command node.exe -ErrorAction Stop
  $nodeExePath = $nodeCommand.Source
  $nodeVersion = (& $nodeExePath --version).Trim()
  $nodeSha = (Get-FileHash -Algorithm SHA256 -Path $nodeExePath).Hash.ToLowerInvariant()
  $ffmpegArchive = New-ZipFixture -FixtureName "ffmpeg-fixture" -Files @{
    "ffmpeg.exe" = $nodeExePath
    "ffprobe.exe" = $nodeExePath
  }
  $ffmpegArchiveSha = (Get-FileHash -Algorithm SHA256 -Path $ffmpegArchive).Hash.ToLowerInvariant()

  Test-WriteTokenPreservesExisting
  Test-YtDlpStateSkip -NodeExePath $nodeExePath -NodeVersion $nodeVersion -NodeSha $nodeSha
  Test-YtDlpFailureKeepsExisting -NodeExePath $nodeExePath
  Test-FfmpegStateSkip -NodeExePath $nodeExePath -ArchivePath $ffmpegArchive -ArchiveSha $ffmpegArchiveSha
  Test-FfmpegFailureKeepsExisting -NodeExePath $nodeExePath
  Test-NodeRuntimeSkippedWhenUnmanaged
  Test-NodeRuntimeInstallFromExplicitPath -NodeExePath $nodeExePath -NodeVersion $nodeVersion
  Test-NodeRuntimeFailureKeepsManaged -NodeExePath $nodeExePath
  Test-StartupTaskMissingServerWarns

  Write-Host "windows-installer-script-tests: OK"
} finally {
  Remove-Item -Path $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
