# Bootstrap: clone repo and run installer. Use with irm for one-line install.
# One-liner (Windows PowerShell):
#   irm https://raw.githubusercontent.com/dev-nolant/porch/main/scripts/bootstrap.ps1 | iex
#
# With -NoStartup: $env:NO_STARTUP=1; irm ... | iex

$ErrorActionPreference = "Stop"
$GithubRepo = if ($env:GITHUB_REPO) { $env:GITHUB_REPO } else { "https://github.com/dev-nolant/porch.git" }
$Dest = if ($env:DEST) { $env:DEST } else { Join-Path $env:USERPROFILE "porch" }
$Subdir = if ($env:SUBDIR) { $env:SUBDIR } else { "" }

Write-Host "Porch — bootstrap" -ForegroundColor Cyan
Write-Host "  https://porch.sh — https://github.com/dev-nolant/porch" -ForegroundColor DarkGray
Write-Host "Cloning to $Dest ..."

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "Git is not installed or not available in PATH."
}

if (Test-Path $Dest) {
    Write-Host "Directory exists. Updating..."
    Push-Location $Dest

    git fetch --depth 1 origin | Out-Null

    $defaultBranch = git remote show origin | Select-String "HEAD branch" | ForEach-Object {
        $_.ToString().Split(":")[1].Trim()
    }

    if (-not $defaultBranch) {
        $defaultBranch = git rev-parse --abbrev-ref HEAD
    }

    git reset --hard "origin/$defaultBranch" | Out-Null

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