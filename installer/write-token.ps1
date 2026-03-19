param(
  [Parameter(Mandatory = $true)]
  [string]$AppDir,
  [string]$InstallMode = "install",
  [string]$ApiToken = "",
  [string]$ApiTokenFile = "",
  [string]$ResultPath = ""
)

$ErrorActionPreference = "Stop"
$commonPath = Join-Path $PSScriptRoot "installer-common.ps1"
. $commonPath

$mode = Resolve-InstallModeText -InstallMode $InstallMode
$tokenPattern = '^[a-f0-9]{64}$'
$token = ""
$path = Join-Path $AppDir "ytgrabber.token"
$warning = $false
$message = ""

function Read-ExistingToken {
  if (-not (Test-Path $path)) {
    return ""
  }

  try {
    return (Get-Content -Path $path -Raw).Trim()
  } catch {
    return ""
  }
}

function Normalize-Token {
  param([string]$Value)

  $raw = [string]$Value
  $raw = $raw.Replace([string][char]0xFEFF, "").Replace("`0", "")
  $raw = $raw.Trim().ToLowerInvariant()
  if ([string]::IsNullOrWhiteSpace($raw)) {
    return ""
  }
  if ($raw -notmatch $tokenPattern) {
    return ""
  }
  return $raw
}

$existingToken = Read-ExistingToken
$normalizedExistingToken = Normalize-Token -Value $existingToken

if (-not [string]::IsNullOrWhiteSpace($ApiTokenFile)) {
  if (Test-Path $ApiTokenFile) {
    $token = Normalize-Token -Value (Get-Content -Path $ApiTokenFile -Raw)
    if ([string]::IsNullOrWhiteSpace($token)) {
      $warning = $true
      $message = "Token override file was invalid; preserved the current token."
    }
  } else {
    $warning = $true
    $message = "Token override file was not found; preserved the current token."
  }
} elseif (-not [string]::IsNullOrWhiteSpace($ApiToken)) {
  $token = Normalize-Token -Value $ApiToken
  if ([string]::IsNullOrWhiteSpace($token)) {
    $warning = $true
    $message = "Explicit token override was invalid; preserved the current token."
  }
}

if ([string]::IsNullOrWhiteSpace($token) -and -not [string]::IsNullOrWhiteSpace($normalizedExistingToken)) {
  $token = $normalizedExistingToken
}

if ([string]::IsNullOrWhiteSpace($token)) {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $token = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""
  if ($warning -and [string]::IsNullOrWhiteSpace($normalizedExistingToken)) {
    $message = "Token override failed; generated a new token."
  } elseif ([string]::IsNullOrWhiteSpace($message)) {
    $message = "Generated a new API token."
  }
} elseif ([string]::IsNullOrWhiteSpace($message)) {
  if ([string]::IsNullOrWhiteSpace($normalizedExistingToken)) {
    $message = "Stored the API token for this $mode."
  } elseif ($token -eq $normalizedExistingToken) {
    $message = "Kept the existing API token."
  } else {
    $message = "Updated the API token."
  }
}

Write-TextFileUtf8NoBom -Path $path -Content $token

$status = if ([string]::IsNullOrWhiteSpace($normalizedExistingToken)) {
  "installed"
} elseif ($token -eq $normalizedExistingToken) {
  "kept"
} else {
  "updated"
}

Write-InstallerResult -ResultPath $ResultPath -Component "token" -Status $status -Message $message -Warning:$warning
