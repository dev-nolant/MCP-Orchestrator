# Enable MCP Orchestrator auto-start on login.
# Creates a scheduled task to start the server when you log in.

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$OrchDir = Split-Path -Parent $ScriptDir

# Stop any running instance
& "$ScriptDir\stop.ps1" | Out-Null

Unregister-ScheduledTask -TaskName "MCP Orchestrator" -Confirm:$false -ErrorAction SilentlyContinue
$nodePath = (Get-Command node).Source
$action = New-ScheduledTaskAction -Execute $nodePath -Argument "build/server.js" -WorkingDirectory $OrchDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName "MCP Orchestrator" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

# Start now
Start-ScheduledTask -TaskName "MCP Orchestrator"
Write-Host "Auto-start enabled (Task Scheduler). Server is running."
