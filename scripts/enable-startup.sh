#!/usr/bin/env bash
# Enable Porch auto-start on login.
# Sets up launchd (Mac) or systemd (Linux) to start the server when you log in.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORCH_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_FILE="$ORCH_DIR/.porch.pid"

# Stop nohup instance if running
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  kill "$OLD_PID" 2>/dev/null || true
  rm -f "$PID_FILE"
fi

if [ "$(uname)" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/com.porch.server.plist"
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.porch.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v node)</string>
    <string>build/server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$ORCH_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>$ORCH_DIR/.porch.log</string>
  <key>StandardErrorPath</key>
  <string>$ORCH_DIR/.porch.log</string>
</dict>
</plist>
PLISTEOF
  launchctl load "$PLIST"
  echo "Auto-start enabled (launchd). Server is running."
else
  SYSTEMD_USER="$HOME/.config/systemd/user"
  mkdir -p "$SYSTEMD_USER"
  cat > "$SYSTEMD_USER/porch.service" << SVCEOF
[Unit]
Description=Porch
After=network.target

[Service]
Type=simple
ExecStart=$(command -v node) build/server.js
WorkingDirectory=$ORCH_DIR
Restart=on-failure
StandardOutput=append:$ORCH_DIR/.porch.log
StandardError=append:$ORCH_DIR/.porch.log

[Install]
WantedBy=default.target
SVCEOF
  systemctl --user daemon-reload
  systemctl --user enable porch.service
  systemctl --user start porch.service
  echo "Auto-start enabled (systemd). Server is running."
fi
