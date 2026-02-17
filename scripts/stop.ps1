# Stop MCP Orchestrator background server (Windows)
# Handles both PID file (manual start) and scheduled task start

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$OrchDir = Split-Path -Parent $ScriptDir
$PidFile = Join-Path $OrchDir ".mcp-orchestrator.pid"

$Stopped = $false

# Try PID file first
if (Test-Path $PidFile) {
    $ServerPid = Get-Content $PidFile -ErrorAction SilentlyContinue
    if ($ServerPid -and (Get-Process -Id $ServerPid -ErrorAction SilentlyContinue)) {
        # /T kills process tree (cmd + child node)
        cmd /c "taskkill /PID $ServerPid /T /F 2>nul"
        Write-Host "Stopped MCP Orchestrator (PID $ServerPid)"
        $Stopped = $true
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

if (-not $Stopped) {
    $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue
    foreach ($p in $procs) {
        if ($p.CommandLine -like "*build\server.js*" -or $p.CommandLine -like "*build/server.js*") {
            Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
            Write-Host "Stopped MCP Orchestrator (PID $($p.ProcessId))"
            $Stopped = $true
            break
        }
    }
}

if (-not $Stopped) {
    Write-Host "MCP Orchestrator is not running."
}