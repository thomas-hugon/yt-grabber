param(
  [Parameter(Mandatory = $true)]
  [string]$AppDir,
  [string]$InstallMode = "install",
  [string]$RemoveOnly = "",
  [string]$ResultPath = ""
)

$ErrorActionPreference = "Stop"
$commonPath = Join-Path $PSScriptRoot "installer-common.ps1"
. $commonPath

$taskName = "YTGrabber"
$taskDescription = "Starts the YT Grabber server when the current user signs in."
$serverExe = Join-Path $AppDir "YTGrabber-Server.exe"
$mode = Resolve-InstallModeText -InstallMode $InstallMode
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

  Write-InstallerResult -ResultPath $ResultPath -Component "startup-task" -Status $Status -Message $Message -Warning:$Warning
  $script:resultWritten = $true
}

if ($removeOnlyRequested) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  exit 0
}

$hadExistingTask = $false
try {
  $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  $hadExistingTask = $null -ne $existingTask

  if (-not (Test-Path $serverExe)) {
    throw "Server executable not found: $serverExe"
  }

  $userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  if ([string]::IsNullOrWhiteSpace($userId)) {
    throw "Unable to resolve the current Windows user for startup registration."
  }

  $action = New-ScheduledTaskAction -Execute $serverExe -WorkingDirectory $AppDir
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
  $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable

  $task = New-ScheduledTask `
    -Action $action `
    -Description $taskDescription `
    -Principal $principal `
    -Settings $settings `
    -Trigger $trigger

  Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null

  $registeredTask = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
  $registeredAction = @($registeredTask.Actions | Where-Object { $_.Execute }) | Select-Object -First 1
  if (-not $registeredAction) {
    throw "Scheduled task was created without an executable action."
  }
  if ([string]::Compare([string]$registeredAction.Execute, $serverExe, $true) -ne 0) {
    throw "Scheduled task action does not point to the installed server executable."
  }

  if ($hadExistingTask) {
    Write-ResultOnce -Status "updated" -Message "Updated the Windows logon startup task during this $mode."
  } else {
    Write-ResultOnce -Status "installed" -Message "Registered the Windows logon startup task during this $mode."
  }
} catch {
  $errorText = $_.Exception.Message
  $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($null -ne $existingTask) {
    Write-ResultOnce -Status "kept" -Message "Failed to refresh the Windows logon startup task during this $mode; kept the existing task. $errorText" -Warning:$true
  } else {
    Write-ResultOnce -Status "warning" -Message "Failed to register the Windows logon startup task during this $mode. $errorText" -Warning:$true
  }
}
