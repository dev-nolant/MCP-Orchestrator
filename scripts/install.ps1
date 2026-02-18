# Porch — Windows installer
# Adds porch.local to hosts, installs deps, starts server in background
# Optional: auto-start when PC boots (use -NoStartup to skip)
# Run in PowerShell (as Administrator for hosts file): .\scripts\install.ps1 [-NoStartup]

param(
    [switch]$NoStartup,
    [switch]$Cloudflared,
    [switch]$NoCloudflared,
    [switch]$Uv,
    [switch]$NoUv
)

$ErrorActionPreference = "Stop"
$Hostname = "porch.local"
$Port = if ($env:PORT) { $env:PORT } else { "3847" }
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$OrchDir = Split-Path -Parent $ScriptDir
$PidFile = Join-Path $OrchDir ".porch.pid"
$LogFile = Join-Path $OrchDir ".porch.log"
$ErrFile = Join-Path $OrchDir ".porch.err"
$HostsPath = "C:\Windows\System32\drivers\etc\hosts"
$HostsLine = "127.0.0.1 $Hostname"

Write-Host "Porch installer" -ForegroundColor Cyan
Write-Host "==============="
Write-Host ""
Write-Host "  https://porch.sh - " -NoNewline -ForegroundColor Gray
Write-Host "https://github.com/dev-nolant/porch" -ForegroundColor DarkGray
Write-Host ""

# Check Node.js
try {
    $nodeVersion = & node -v 2>$null
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

# Cloudflared install (for Public URLs / tunnels)
$InstallCloudflared = $null
if ($Cloudflared) { $InstallCloudflared = $true }
if ($NoCloudflared) { $InstallCloudflared = $false }
if ($null -eq $InstallCloudflared) {
    Write-Host ""
    Write-Host "Install cloudflared? (required for Public URLs / tunnels)" -ForegroundColor Cyan
    Write-Host "  1) Yes"
    Write-Host "  2) No"
    Write-Host ""
    $choice = Read-Host "Choice [1-2] (default: 2)"
    if ([string]::IsNullOrWhiteSpace($choice)) { $choice = "2" }
    $InstallCloudflared = ($choice -eq "1")
}

if ($InstallCloudflared) {
    Write-Host ""
    Write-Host "Installing cloudflared..." -ForegroundColor Cyan
    if (Get-Command cloudflared -ErrorAction SilentlyContinue) {
        Write-Host "  [OK] cloudflared already installed" -ForegroundColor Green
    } elseif (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install Cloudflare.cloudflared --accept-source-agreements --accept-package-agreements 2>$null
    } elseif (Get-Command choco -ErrorAction SilentlyContinue) {
        choco install cloudflared -y 2>$null
    } else {
        Write-Host "  Install manually: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/download-and-install/" -ForegroundColor Yellow
    }
}

# uv install (for Python MCPs from Discover)
$InstallUv = $null
if ($Uv) { $InstallUv = $true }
if ($NoUv) { $InstallUv = $false }
if ($null -eq $InstallUv) {
    Write-Host ""
    Write-Host "Install uv? (enables Python MCPs from Discover, e.g. fast-mcp-telegram)" -ForegroundColor Cyan
    Write-Host "  1) Yes"
    Write-Host "  2) No"
    Write-Host ""
    $choice = Read-Host "Choice [1-2] (default: 2)"
    if ([string]::IsNullOrWhiteSpace($choice)) { $choice = "2" }
    $InstallUv = ($choice -eq "1")
}

if ($InstallUv) {
    Write-Host ""
    Write-Host "Installing uv..." -ForegroundColor Cyan
    if (Get-Command uv -ErrorAction SilentlyContinue) {
        Write-Host "  [OK] uv already installed" -ForegroundColor Green
    } elseif (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install -e --id astral-sh.uv --accept-source-agreements --accept-package-agreements 2>$null
    } elseif (Get-Command choco -ErrorAction SilentlyContinue) {
        choco install uv -y 2>$null
    } else {
        Write-Host "  Install manually: https://docs.astral.sh/uv/getting-started/installation/" -ForegroundColor Yellow
    }
}

# Add porch.local to hosts if missing
$hostsContent = Get-Content $HostsPath -Raw -ErrorAction SilentlyContinue
if ($hostsContent -match "127\.0\.0\.1\s+$Hostname") {
    Write-Host "`n  [OK] $Hostname already in hosts file"
} else {
    Write-Host "`n  Adding $Hostname to hosts file (requires Administrator)..." -ForegroundColor Yellow
    try {
        Add-Content -Path $HostsPath -Value "`n# Porch`n$HostsLine" -ErrorAction Stop
        Write-Host "  [OK] Added $Hostname to hosts file"
    } catch {
        Write-Host "  Could not add to hosts. Run as Administrator or add manually: $HostsLine"
    }
}

# Copy example config if none exists
$Config = Join-Path $OrchDir "porch.config.json"
$Example = Join-Path $OrchDir "porch.config.example.json"
if (-not (Test-Path $Config) -and (Test-Path $Example)) {
    Copy-Item $Example $Config -Force
    Write-Host "  [OK] Created porch.config.json from example" -ForegroundColor Green
}

# Install deps and build
Write-Host "`nInstalling dependencies..."
Set-Location $OrchDir
npm install
npm run build

# Encrypted secrets setup (stores key in OS Credential Manager, no plain-text file)
$InstallSecrets = $null
if ($null -eq $InstallSecrets) {
    Write-Host ""
    Write-Host "Set up encrypted secrets storage? (recommended; stores key in OS Credential Manager)" -ForegroundColor Cyan
    Write-Host "  1) Yes"
    Write-Host "  2) No (use legacy plain secrets file)"
    Write-Host ""
    $choice = Read-Host "Choice [1-2] (default: 1)"
    if ([string]::IsNullOrWhiteSpace($choice)) { $choice = "1" }
    $InstallSecrets = ($choice -eq "1")
}
if ($InstallSecrets) {
    npm run setup-encryption 2>$null
    if ($LASTEXITCODE -eq 0) { Write-Host "  [OK] Encrypted secrets configured (key in Credential Manager)" -ForegroundColor Green }
    else { Write-Host "  Setup failed. Run: npm run setup-encryption" -ForegroundColor Yellow }
} else {
    Write-Host "  Encrypted secrets: skipped" -ForegroundColor Gray
}

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

# Start server in background (keychain is read automatically at startup)
Write-Host "`nStarting Porch in background..."

if (Test-Path $LogFile) { Remove-Item $LogFile -Force -ErrorAction SilentlyContinue }
if (Test-Path $ErrFile) { Remove-Item $ErrFile -Force -ErrorAction SilentlyContinue }

$proc = Start-Process `
    -FilePath "node" `
    -ArgumentList "build/server.js" `
    -WorkingDirectory $OrchDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $LogFile `
    -RedirectStandardError $ErrFile `
    -PassThru

$proc.Id | Out-File -FilePath $PidFile -Encoding ascii -Force

Start-Sleep -Seconds 2
if (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue) {
    Write-Host "  [OK] Server started (PID $($proc.Id))" -ForegroundColor Green
    Write-Host ""
    Write-Host "Open in your browser:" -ForegroundColor Cyan
    Write-Host "  http://${Hostname}:${Port}"
    Write-Host "  or http://localhost:${Port}"
    Write-Host ""

    if ($NoStartup) {
        Write-Host "Auto-start on login: skipped (-NoStartup)" -ForegroundColor Gray
        Write-Host "To enable later: .\scripts\enable-startup.ps1"
    } else {
        Write-Host "Setting up auto-start on login..."
        Unregister-ScheduledTask -TaskName "Porch" -Confirm:$false -ErrorAction SilentlyContinue
        $nodePath = (Get-Command node).Source
        $action = New-ScheduledTaskAction -Execute $nodePath -Argument "build/server.js" -WorkingDirectory $OrchDir
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
        Register-ScheduledTask -TaskName "Porch" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
        Write-Host "  [OK] Auto-start enabled (Task Scheduler)" -ForegroundColor Green
        Write-Host "To disable: .\scripts\disable-startup.ps1"
    }

    Write-Host ""
    Write-Host "To stop: .\scripts\stop.ps1"
    Write-Host "Logs:   Get-Content $LogFile -Wait -Tail 20"
    Write-Host "Errors: Get-Content $ErrFile -Wait -Tail 20"
} else {
    Write-Host "  Server may have failed to start. Check: $LogFile and $ErrFile" -ForegroundColor Yellow
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    exit 1
}