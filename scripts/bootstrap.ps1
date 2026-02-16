# Bootstrap: clone repo and run installer. Use with irm for one-line install.
# One-liner (Windows PowerShell):
#   irm https://raw.githubusercontent.com/dev-nolant/MCP-Orchestrator/main/scripts/bootstrap.ps1 | iex
#
# With -NoStartup: $env:NO_STARTUP=1; irm ... | iex

$ErrorActionPreference = "Stop"
$GithubRepo = if ($env:GITHUB_REPO) { $env:GITHUB_REPO } else { "https://github.com/dev-nolant/MCP-Orchestrator.git" }
$Dest = if ($env:DEST) { $env:DEST } else { Join-Path $env:USERPROFILE "mcp-orchestrator" }
$Subdir = if ($env:SUBDIR) { $env:SUBDIR } else { "" }

Write-Host "MCP Orchestrator — bootstrap" -ForegroundColor Cyan
Write-Host "  Created and maintained by Nolan Taft — https://github.com/dev-nolant/MCP-Orchestrator" -ForegroundColor DarkGray
Write-Host "Cloning to $Dest ..."

if (Test-Path $Dest) {
    Write-Host "Directory exists. Updating..."
    Push-Location $Dest
    try {
        git fetch --depth 1 origin
        git reset --hard origin/main
    } catch {
        Write-Host "Git update completed (any warnings above can be ignored)" -ForegroundColor Yellow
    }
    Pop-Location
} else {
    git clone --depth 1 $GithubRepo $Dest
}

$InstallDir = $Dest
if ($Subdir) { $InstallDir = Join-Path $Dest $Subdir }
Set-Location $InstallDir

$installArgs = @()
if ($env:NO_STARTUP -eq "1" -or $env:NO_STARTUP -eq "true") { $installArgs = @("-NoStartup") }
& "$InstallDir\scripts\install.ps1" @installArgs @args
