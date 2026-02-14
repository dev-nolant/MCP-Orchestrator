# Update MCP Orchestrator: git pull, npm install, npm run build, restart server

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$OrchDir = Split-Path -Parent $ScriptDir

Write-Host "MCP Orchestrator — updater" -ForegroundColor Cyan
Write-Host "=========================="

# Find git root (handles monorepo)
$GitRoot = $OrchDir
try {
    $gr = git -C $OrchDir rev-parse --show-toplevel 2>$null
    if ($gr) { $GitRoot = $gr.Trim() }
} catch {}

# Stop server
Write-Host ""
Write-Host "Stopping server..."
& "$ScriptDir\stop.ps1" 2>$null
Start-Sleep -Seconds 1

# Update
Write-Host ""
Write-Host "Pulling latest changes..."
Set-Location $GitRoot
try {
    git pull --rebase 2>$null
} catch {
    git pull 2>$null
}
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [!] git pull failed (not a git repo?)" -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "Installing dependencies..."
Set-Location $OrchDir
npm install
npm run build

# Start server
Write-Host ""
Write-Host "Starting server..."
& "$ScriptDir\start.ps1"

Write-Host ""
Write-Host "[OK] Update complete." -ForegroundColor Green
