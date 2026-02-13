# Disable MCP Orchestrator auto-start on login.
# Stops the server and removes the scheduled task.

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& "$ScriptDir\stop.ps1" | Out-Null

$task = Get-ScheduledTask -TaskName "MCP Orchestrator" -ErrorAction SilentlyContinue
if ($task) {
    Unregister-ScheduledTask -TaskName "MCP Orchestrator" -Confirm:$false
    Write-Host "Auto-start disabled (removed scheduled task)"
} else {
    Write-Host "Auto-start was not enabled."
}
