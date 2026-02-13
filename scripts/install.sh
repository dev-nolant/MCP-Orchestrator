#!/usr/bin/env bash
# MCP Orchestrator — Mac & Linux installer
# Adds mcporch.local to hosts, installs deps, starts server in background
# Optional: sets up auto-start when PC boots (use --no-startup to skip)

set -e

HOSTNAME="mcporch.local"
PORT="${PORT:-3847}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORCH_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_FILE="$ORCH_DIR/.mcp-orchestrator.pid"
HOSTS_LINE="127.0.0.1 $HOSTNAME"

NO_STARTUP=false
for arg in "$@"; do
  case "$arg" in
    --no-startup) NO_STARTUP=true ;;
  esac
done

echo "MCP Orchestrator installer"
echo "=========================="

# Check Node.js
if ! command -v node &>/dev/null; then
  echo "Error: Node.js is required. Install from https://nodejs.org"
  exit 1
fi

NODE_VER=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ] 2>/dev/null; then
  echo "Error: Node.js 18+ required. Current: $(node -v)"
  exit 1
fi

# Add mcporch.local to hosts if missing
add_hosts() {
  if grep -qE "127\.0\.0\.1[[:space:]]+${HOSTNAME}" /etc/hosts 2>/dev/null; then
    echo "  ✓ $HOSTNAME already in /etc/hosts"
    return 0
  fi
  echo "  Adding $HOSTNAME to /etc/hosts (requires sudo)..."
  if printf '\n# MCP Orchestrator\n%s\n' "$HOSTS_LINE" | sudo tee -a /etc/hosts >/dev/null 2>&1; then
    echo "  ✓ Added $HOSTNAME to /etc/hosts"
  else
    echo "  ⚠ Could not add to /etc/hosts. You can add manually:"
    echo "    echo '$HOSTS_LINE' | sudo tee -a /etc/hosts"
    echo "  You can still use http://localhost:$PORT"
  fi
}

# Copy example config if none exists
CONFIG="$ORCH_DIR/mcp-orchestrator.config.json"
EXAMPLE="$ORCH_DIR/mcp-orchestrator.config.example.json"
if [ ! -f "$CONFIG" ] && [ -f "$EXAMPLE" ]; then
  cp "$EXAMPLE" "$CONFIG"
  echo "  ✓ Created mcp-orchestrator.config.json from example"
fi

# Install deps and build
echo ""
echo "Installing dependencies..."
cd "$ORCH_DIR"
npm install
npm run build

# Add hosts entry
echo ""
echo "Configuring $HOSTNAME..."
add_hosts

# Stop existing server if running
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo ""
    echo "Stopping existing server (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 1
  fi
  rm -f "$PID_FILE"
fi

# Unload launchd/systemd if present (we'll re-install)
if [ "$(uname)" = "Darwin" ] && [ -f "$HOME/Library/LaunchAgents/com.mcp-orchestrator.server.plist" ]; then
  launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.mcp-orchestrator.server.plist" 2>/dev/null || true
elif [ -f "$HOME/.config/systemd/user/mcp-orchestrator.service" ]; then
  systemctl --user stop mcp-orchestrator.service 2>/dev/null || true
fi

# Start server in background
echo ""
echo "Starting MCP Orchestrator in background..."
cd "$ORCH_DIR"

if [ "$NO_STARTUP" = true ]; then
  nohup node build/server.js > "$ORCH_DIR/.mcp-orchestrator.log" 2>&1 &
  echo $! > "$PID_FILE"
else
  if [ "$(uname)" = "Darwin" ]; then
    PLIST="$HOME/Library/LaunchAgents/com.mcp-orchestrator.server.plist"
    mkdir -p "$(dirname "$PLIST")"
    cat > "$PLIST" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.mcp-orchestrator.server</string>
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
  <string>$ORCH_DIR/.mcp-orchestrator.log</string>
  <key>StandardErrorPath</key>
  <string>$ORCH_DIR/.mcp-orchestrator.log</string>
</dict>
</plist>
PLISTEOF
    launchctl load "$PLIST"
  else
    SYSTEMD_USER="$HOME/.config/systemd/user"
    mkdir -p "$SYSTEMD_USER"
    cat > "$SYSTEMD_USER/mcp-orchestrator.service" << SVCEOF
[Unit]
Description=MCP Orchestrator
After=network.target

[Service]
Type=simple
ExecStart=$(command -v node) build/server.js
WorkingDirectory=$ORCH_DIR
Restart=on-failure
StandardOutput=append:$ORCH_DIR/.mcp-orchestrator.log
StandardError=append:$ORCH_DIR/.mcp-orchestrator.log

[Install]
WantedBy=default.target
SVCEOF
    systemctl --user daemon-reload
    systemctl --user enable mcp-orchestrator.service
    systemctl --user start mcp-orchestrator.service
  fi
fi

sleep 1
SERVER_OK=false
if [ "$NO_STARTUP" = true ]; then
  if kill -0 $(cat "$PID_FILE") 2>/dev/null; then SERVER_OK=true; fi
elif [ "$(uname)" = "Darwin" ]; then
  launchctl list 2>/dev/null | grep -q com.mcp-orchestrator.server && SERVER_OK=true
else
  systemctl --user is-active mcp-orchestrator.service &>/dev/null && SERVER_OK=true
fi

if [ "$SERVER_OK" = true ]; then
  if [ "$NO_STARTUP" = true ]; then
    echo "  ✓ Server started (PID $(cat "$PID_FILE"))"
  else
    echo "  ✓ Server started (auto-start enabled)"
  fi
  echo ""
  echo "Open in your browser:"
  echo "  http://${HOSTNAME}:${PORT}"
  echo "  or http://localhost:${PORT}"
  echo ""
  if [ "$NO_STARTUP" = true ]; then
    echo "Auto-start on login: skipped (--no-startup)"
    echo "To enable later: ./scripts/enable-startup.sh"
  else
    echo "Auto-start on login: enabled"
    echo "To disable: ./scripts/disable-startup.sh"
  fi
  echo ""
  echo "To stop: ./scripts/stop.sh"
  echo "Logs:   tail -f $ORCH_DIR/.mcp-orchestrator.log"
else
  echo "  ⚠ Server may have failed to start. Check: $ORCH_DIR/.mcp-orchestrator.log"
  rm -f "$PID_FILE"
  exit 1
fi
