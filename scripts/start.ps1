# Start Porch in background (Windows)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$OrchDir = Split-Path -Parent $ScriptDir
$PidFile = Join-Path $OrchDir ".porch.pid"
$LogFile = Join-Path $OrchDir ".porch.log"
$ErrFile = Join-Path $OrchDir ".porch.err"
$Port = if ($env:PORT) { $env:PORT } else { "3847" }

if (Test-Path $PidFile) {
    $Pid = Get-Content $PidFile -ErrorAction SilentlyContinue
    if ($Pid -and (Get-Process -Id $Pid -ErrorAction SilentlyContinue)) {
        Write-Host "Porch is already running (PID $Pid)"
        Write-Host "  http://porch.local:$Port or http://localhost:$Port"
        exit 0
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

Set-Location $OrchDir
# cmd /c avoids PowerShell bug: RedirectStandardOutput/RedirectStandardError "are same"
$runCmd = "node build\server.js 1> `"$LogFile`" 2> `"$ErrFile`""
$proc = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", $runCmd -WorkingDirectory $OrchDir -WindowStyle Hidden -PassThru
$proc.Id | Out-File -FilePath $PidFile -Encoding ascii
Write-Host "Started Porch (PID $($proc.Id))"
Write-Host "  http://porch.local:$Port or http://localhost:$Port"
