# MCP Orchestrator — Windows installer
# Adds mcporch.local to hosts, installs deps, starts server in background
# Optional: auto-start when PC boots (use -NoStartup to skip)
# Run in PowerShell (as Administrator for hosts file): .\scripts\install.ps1 [-NoStartup]

param(
    [switch]$NoStartup
)

$ErrorActionPreference = "Stop"
$Hostname = "mcporch.local"
$Port = if ($env:PORT) { $env:PORT } else { "3847" }
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$OrchDir = Split-Path -Parent $ScriptDir
$PidFile = Join-Path $OrchDir ".mcp-orchestrator.pid"
$LogFile = Join-Path $OrchDir ".mcp-orchestrator.log"
$HostsPath = "C:\Windows\System32\drivers\etc\hosts"
$HostsLine = "127.0.0.1 $Hostname"

Write-Host "MCP Orchestrator installer" -ForegroundColor Cyan
Write-Host "=========================="

# Check Node.js
try {
    $nodeVersion = node -v 2>$null
    if (-not $nodeVersion) { throw "Node not found" }
    $major = [int]($nodeVersion -replace 'v(\d+)\..*','$1')
    if ($major -lt 18) {
        Write-Host "Error: Node.js 18+ required. Current: $nodeVersion" -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "Error: Node.js is required. Install from https://nodejs.org" -ForegroundColor Red
    exit 1
}

# Add mcporch.local to hosts if missing
$hostsContent = Get-Content $HostsPath -Raw -ErrorAction SilentlyContinue
if ($hostsContent -match "127\.0\.0\.1\s+$Hostname") {
    Write-Host "`n  [OK] $Hostname already in hosts file"
} else {
    Write-Host "`n  Adding $Hostname to hosts file (requires Administrator)..." -ForegroundColor Yellow
    try {
        Add-Content -Path $HostsPath -Value "`n# MCP Orchestrator`n$HostsLine" -ErrorAction Stop
        Write-Host "  [OK] Added $Hostname to hosts file"
    } catch {
        Write-Host "  [!] Could not add to hosts. Run this script as Administrator, or add manually:" -ForegroundColor Yellow
        Write-Host "      Add this line to $HostsPath : $HostsLine"
        Write-Host "  You can still use http://localhost:$Port"
    }
}

# Install deps and build
Write-Host "`nInstalling dependencies..."
Set-Location $OrchDir
npm install
npm run build

# Stop existing server if running
if (Test-Path $PidFile) {
    $oldPid = Get-Content $PidFile -ErrorAction SilentlyContinue
    if ($oldPid -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
        Write-Host "`nStopping existing server (PID $oldPid)..."
        Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

# Start server in background
Write-Host "`nStarting MCP Orchestrator in background..."
$proc = Start-Process -FilePath "node" -ArgumentList "build/server.js" -WorkingDirectory $OrchDir -WindowStyle Hidden -PassThru -RedirectStandardOutput $LogFile -RedirectStandardError $LogFile
$proc.Id | Out-File -FilePath $PidFile -Encoding ascii

Start-Sleep -Seconds 1
if (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue) {
    Write-Host "  [OK] Server started (PID $($proc.Id))" -ForegroundColor Green
    Write-Host "`nOpen in your browser:" -ForegroundColor Cyan
    Write-Host "  http://${Hostname}:${Port}"
    Write-Host "  or http://localhost:${Port}"
    Write-Host ""

    if ($NoStartup) {
        Write-Host "Auto-start on login: skipped (-NoStartup)" -ForegroundColor Gray
        Write-Host "To enable later: .\scripts\enable-startup.ps1"
    } else {
        Write-Host "Setting up auto-start on login..."
        Unregister-ScheduledTask -TaskName "MCP Orchestrator" -Confirm:$false -ErrorAction SilentlyContinue
        $nodePath = (Get-Command node).Source
        $action = New-ScheduledTaskAction -Execute $nodePath -Argument "build/server.js" -WorkingDirectory $OrchDir
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
        Register-ScheduledTask -TaskName "MCP Orchestrator" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
        Write-Host "  [OK] Auto-start enabled (Task Scheduler)" -ForegroundColor Green
        Write-Host "To disable: .\scripts\disable-startup.ps1"
    }

    Write-Host "`nTo stop: .\scripts\stop.ps1"
    Write-Host "Logs:   Get-Content $LogFile -Wait -Tail 20"
} else {
    Write-Host "  [!] Server may have failed to start. Check: $LogFile" -ForegroundColor Yellow
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    exit 1
}
