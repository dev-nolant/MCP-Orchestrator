# Start MCP Orchestrator in background (Windows)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$OrchDir = Split-Path -Parent $ScriptDir
$PidFile = Join-Path $OrchDir ".mcp-orchestrator.pid"
$LogFile = Join-Path $OrchDir ".mcp-orchestrator.log"
$Port = if ($env:PORT) { $env:PORT } else { "3847" }

if (Test-Path $PidFile) {
    $Pid = Get-Content $PidFile -ErrorAction SilentlyContinue
    if ($Pid -and (Get-Process -Id $Pid -ErrorAction SilentlyContinue)) {
        Write-Host "MCP Orchestrator is already running (PID $Pid)"
        Write-Host "  http://mcporch.local:$Port or http://localhost:$Port"
        exit 0
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

Set-Location $OrchDir
$proc = Start-Process -FilePath "node" -ArgumentList "build/server.js" -WorkingDirectory $OrchDir -WindowStyle Hidden -PassThru -RedirectStandardOutput $LogFile -RedirectStandardError $LogFile
$proc.Id | Out-File -FilePath $PidFile -Encoding ascii
Write-Host "Started MCP Orchestrator (PID $($proc.Id))"
Write-Host "  http://mcporch.local:$Port or http://localhost:$Port"
