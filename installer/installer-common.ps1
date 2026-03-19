Set-StrictMode -Version Latest
$script:Utf8NoBomEncoding = New-Object System.Text.UTF8Encoding($false)

function Write-TextFileUtf8NoBom {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [string]$Content
  )

  [System.IO.File]::WriteAllText($Path, $Content, $script:Utf8NoBomEncoding)
}

function New-InstallerState {
  return [ordered]@{
    schema_version = 1
    ytdlp = $null
    ffmpeg = $null
    node = $null
  }
}

function ConvertTo-PlainValue {
  param($Value)

  if ($null -eq $Value) {
    return $null
  }

  if ($Value -is [System.Management.Automation.PSCustomObject]) {
    $result = [ordered]@{}
    foreach ($prop in $Value.PSObject.Properties) {
      $result[$prop.Name] = ConvertTo-PlainValue $prop.Value
    }
    return $result
  }

  if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string])) {
    $items = @()
    foreach ($item in $Value) {
      $items += ,(ConvertTo-PlainValue $item)
    }
    return $items
  }

  return $Value
}

function Get-InstallerStatePath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$AppDir
  )

  return Join-Path $AppDir "ytgrabber-installer-state.json"
}

function Read-InstallerState {
  param(
    [Parameter(Mandatory = $true)]
    [string]$AppDir
  )

  $state = New-InstallerState
  $path = Get-InstallerStatePath -AppDir $AppDir
  if (-not (Test-Path $path)) {
    return $state
  }

  try {
    $raw = Get-Content -Path $path -Raw
    if ([string]::IsNullOrWhiteSpace($raw)) {
      return $state
    }

    $loaded = ConvertTo-PlainValue ($raw | ConvertFrom-Json)
    if ($loaded.Contains("schema_version")) {
      $state["schema_version"] = [int]$loaded["schema_version"]
    }
    foreach ($key in @("ytdlp", "ffmpeg", "node")) {
      if ($loaded.Contains($key)) {
        $state[$key] = $loaded[$key]
      }
    }
  } catch {
    return $state
  }

  return $state
}

function Write-InstallerState {
  param(
    [Parameter(Mandatory = $true)]
    [string]$AppDir,
    [Parameter(Mandatory = $true)]
    [hashtable]$State
  )

  $path = Get-InstallerStatePath -AppDir $AppDir
  $json = $State | ConvertTo-Json -Depth 8
  Write-TextFileUtf8NoBom -Path $path -Content ($json + "`r`n")
}

function New-InstallerTempPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$AppDir,
    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  $extension = [System.IO.Path]::GetExtension($Name)
  $stem = if ([string]::IsNullOrWhiteSpace($extension)) {
    $Name
  } else {
    [System.IO.Path]::GetFileNameWithoutExtension($Name)
  }

  if ([string]::IsNullOrWhiteSpace($extension)) {
    $extension = ".tmp"
  }

  return Join-Path $AppDir ("." + $stem + "." + [Guid]::NewGuid().ToString("N") + $extension)
}

function Test-UsableFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  if (-not (Test-Path $Path)) {
    return $false
  }

  try {
    return (Get-Item $Path).Length -gt 0
  } catch {
    return $false
  }
}

function Get-FileSha256 {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  if (-not (Test-UsableFile -Path $Path)) {
    return ""
  }

  try {
    return (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant()
  } catch {
    return ""
  }
}

function Get-CommandVersionString {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [string[]]$Arguments = @("--version")
  )

  if (-not (Test-UsableFile -Path $Path)) {
    return ""
  }

  try {
    $output = & $Path @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) {
      return ""
    }

    if ($output -is [System.Array]) {
      return [string]($output | Select-Object -First 1)
    }
    return [string]$output
  } catch {
    return ""
  }
}

function Resolve-BooleanFlag {
  param([string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $false
  }

  $normalized = $Value.Trim().ToLowerInvariant()
  return $normalized -in @("1", "true", "yes", "on")
}

function Escape-IniValue {
  param([string]$Value)

  $text = [string]$Value
  $text = $text -replace "`r", " "
  $text = $text -replace "`n", " "
  return $text
}

function Write-InstallerResult {
  param(
    [string]$ResultPath,
    [Parameter(Mandatory = $true)]
    [string]$Component,
    [Parameter(Mandatory = $true)]
    [string]$Status,
    [Parameter(Mandatory = $true)]
    [string]$Message,
    [bool]$Warning = $false
  )

  if ([string]::IsNullOrWhiteSpace($ResultPath)) {
    return
  }

  $content = @(
    "[Result]"
    "component=$(Escape-IniValue $Component)"
    "status=$(Escape-IniValue $Status)"
    "warning=$(if ($Warning) { '1' } else { '0' })"
    "message=$(Escape-IniValue $Message)"
    ""
  ) -join "`r`n"

  Write-TextFileUtf8NoBom -Path $ResultPath -Content $content
}

function Replace-FileWithRollback {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Source,
    [Parameter(Mandatory = $true)]
    [string]$Destination
  )

  $backup = $Destination + ".ytg-backup"
  $hadExisting = Test-Path $Destination

  Remove-Item $backup -Force -ErrorAction SilentlyContinue
  try {
    if ($hadExisting) {
      Move-Item -Path $Destination -Destination $backup -Force
    }

    Move-Item -Path $Source -Destination $Destination -Force
    Remove-Item $backup -Force -ErrorAction SilentlyContinue
  } catch {
    Remove-Item $Source -Force -ErrorAction SilentlyContinue
    if ($hadExisting -and (Test-Path $backup) -and -not (Test-Path $Destination)) {
      Move-Item -Path $backup -Destination $Destination -Force
    }
    throw
  }
}

function Replace-FileSetWithRollback {
  param(
    [Parameter(Mandatory = $true)]
    [array]$Pairs
  )

  foreach ($pair in $Pairs) {
    $pair["Backup"] = $pair["Destination"] + ".ytg-backup"
    $pair["HadExisting"] = Test-Path $pair["Destination"]
    Remove-Item $pair["Backup"] -Force -ErrorAction SilentlyContinue
  }

  try {
    foreach ($pair in $Pairs) {
      if ($pair["HadExisting"]) {
        Move-Item -Path $pair["Destination"] -Destination $pair["Backup"] -Force
      }
    }

    foreach ($pair in $Pairs) {
      Move-Item -Path $pair["Source"] -Destination $pair["Destination"] -Force
    }

    foreach ($pair in $Pairs) {
      Remove-Item $pair["Backup"] -Force -ErrorAction SilentlyContinue
    }
  } catch {
    foreach ($pair in $Pairs) {
      Remove-Item $pair["Source"] -Force -ErrorAction SilentlyContinue
    }

    foreach ($pair in $Pairs) {
      if ($pair["HadExisting"] -and (Test-Path $pair["Backup"]) -and -not (Test-Path $pair["Destination"])) {
        Move-Item -Path $pair["Backup"] -Destination $pair["Destination"] -Force
      }
    }
    throw
  }
}

function Resolve-InstallModeText {
  param([string]$InstallMode)

  if ($InstallMode -eq "update") {
    return "update"
  }
  return "install"
}
