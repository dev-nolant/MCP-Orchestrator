#!/usr/bin/env bash
# Porch — Mac & Linux installer
# Adds porch.local to hosts, installs deps, starts server in background
# Optional: sets up auto-start when PC boots (use --no-startup to skip)

set -e

HOSTNAME="porch.local"
PORT="${PORT:-3847}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORCH_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_FILE="$ORCH_DIR/.porch.pid"
HOSTS_LINE="127.0.0.1 $HOSTNAME"

NO_STARTUP=false
INSTALL_CLOUDFLARED=""
INSTALL_UV=""
for arg in "$@"; do
  case "$arg" in
    --no-startup) NO_STARTUP=true ;;
    --cloudflared) INSTALL_CLOUDFLARED=yes ;;
    --no-cloudflared) INSTALL_CLOUDFLARED=no ;;
    --uv) INSTALL_UV=yes ;;
    --no-uv) INSTALL_UV=no ;;
  esac
done

echo "Porch installer"
echo "==============="
echo ""
echo "  https://porch.sh — https://github.com/dev-nolant/porch"
echo ""

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

# Add porch.local to hosts if missing
add_hosts() {
  if grep -qE "127\.0\.0\.1[[:space:]]+${HOSTNAME}" /etc/hosts 2>/dev/null; then
    echo "  ✓ $HOSTNAME already in /etc/hosts"
    return 0
  fi
  echo "  Adding $HOSTNAME to /etc/hosts (requires sudo)..."
  if printf '\n# Porch\n%s\n' "$HOSTS_LINE" | sudo tee -a /etc/hosts >/dev/null 2>&1; then
    echo "  ✓ Added $HOSTNAME to /etc/hosts"
  else
    echo "  ⚠ Could not add to /etc/hosts. You can add manually:"
    echo "    echo '$HOSTS_LINE' | sudo tee -a /etc/hosts"
    echo "  You can still use http://localhost:$PORT"
  fi
}

# uv install (for Python MCPs from Discover)
install_uv() {
  if command -v uv &>/dev/null; then
    echo "  ✓ uv already installed ($(uv --version 2>/dev/null | head -1 || echo 'uv'))"
    return 0
  fi
  if [ "$(uname)" = "Darwin" ]; then
    if command -v brew &>/dev/null; then
      echo "  Installing uv via Homebrew..."
      brew install uv && echo "  ✓ uv installed" || echo "  ⚠ uv install failed. Run: brew install uv"
    else
      echo "  ⚠ Homebrew not found. Install uv manually: curl -LsSf https://astral.sh/uv/install.sh | sh"
    fi
  else
    echo "  Installing uv..."
    if curl -LsSf https://astral.sh/uv/install.sh | sh 2>/dev/null; then
      echo "  ✓ uv installed (add ~/.local/bin to PATH if needed)"
    else
      echo "  ⚠ uv install failed. Run: curl -LsSf https://astral.sh/uv/install.sh | sh"
    fi
  fi
}

# Cloudflared install (for Public URLs / tunnels)
install_cloudflared() {
  if command -v cloudflared &>/dev/null; then
    echo "  ✓ cloudflared already installed ($(cloudflared --version 2>/dev/null | head -1 || echo 'cloudflared'))"
    return 0
  fi
  if [ "$(uname)" = "Darwin" ]; then
    if command -v brew &>/dev/null; then
      echo "  Installing cloudflared via Homebrew..."
      brew install cloudflared && echo "  ✓ cloudflared installed" || echo "  ⚠ cloudflared install failed. Run: brew install cloudflared"
    else
      echo "  ⚠ Homebrew not found. Install cloudflared manually: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/download-and-install/"
    fi
  else
    if command -v apt-get &>/dev/null; then
      echo "  Installing cloudflared via apt..."
      sudo apt-get update -qq && sudo apt-get install -y cloudflared 2>/dev/null && echo "  ✓ cloudflared installed" || echo "  ⚠ Try: sudo apt-get install cloudflared"
    elif command -v dnf &>/dev/null; then
      echo "  Installing cloudflared via dnf..."
      sudo dnf install -y cloudflared 2>/dev/null && echo "  ✓ cloudflared installed" || echo "  ⚠ Try: sudo dnf install cloudflared"
    else
      echo "  ⚠ Install cloudflared manually: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/download-and-install/"
    fi
  fi
}

if [ -z "$INSTALL_CLOUDFLARED" ]; then
  if [ -t 0 ] && [ -e /dev/tty ]; then
    echo ""
    echo "Install cloudflared? (required for Public URLs / tunnels)"
    echo "  1) Yes"
    echo "  2) No"
    echo ""
    read -r -p "Choice [1-2] (default: 2): " choice < /dev/tty
    choice="${choice:-2}"
    [ "$choice" = "1" ] && INSTALL_CLOUDFLARED=yes || INSTALL_CLOUDFLARED=no
  else
    INSTALL_CLOUDFLARED=no
  fi
fi

if [ "$INSTALL_CLOUDFLARED" = "yes" ]; then
  echo ""
  echo "Installing cloudflared..."
  install_cloudflared
fi

if [ -z "$INSTALL_UV" ]; then
  if [ -t 0 ] && [ -e /dev/tty ]; then
    echo ""
    echo "Install uv? (enables Python MCPs from Discover, e.g. fast-mcp-telegram)"
    echo "  1) Yes"
    echo "  2) No"
    echo ""
    read -r -p "Choice [1-2] (default: 2): " choice < /dev/tty
    choice="${choice:-2}"
    [ "$choice" = "1" ] && INSTALL_UV=yes || INSTALL_UV=no
  else
    INSTALL_UV=no
  fi
fi

if [ "$INSTALL_UV" = "yes" ]; then
  echo ""
  echo "Installing uv..."
  install_uv
fi

# Copy example config if none exists
CONFIG="$ORCH_DIR/porch.config.json"
EXAMPLE="$ORCH_DIR/porch.config.example.json"
if [ ! -f "$CONFIG" ] && [ -f "$EXAMPLE" ]; then
  cp "$EXAMPLE" "$CONFIG"
  echo "  ✓ Created porch.config.json from example"
fi

# Encrypted secrets setup (stores key in OS keychain, no plain-text file)
setup_encrypted_secrets() {
  if [ -z "$INSTALL_SECRETS" ]; then
    if [ -t 0 ] && [ -e /dev/tty ]; then
      echo ""
      echo "Set up encrypted secrets storage? (recommended; stores key in OS keychain, no plain-text file)"
      echo "  1) Yes"
      echo "  2) No (use legacy plain secrets file)"
      echo ""
      read -r -p "Choice [1-2] (default: 1): " choice < /dev/tty
      choice="${choice:-1}"
      [ "$choice" = "1" ] && INSTALL_SECRETS=yes || INSTALL_SECRETS=no
    else
      INSTALL_SECRETS=no
    fi
  fi
  if [ "$INSTALL_SECRETS" != "yes" ]; then
    echo "  Encrypted secrets: skipped"
    return 0
  fi
  cd "$ORCH_DIR"
  if npm run setup-encryption 2>/dev/null; then
    echo "  ✓ Encrypted secrets configured (key in OS keychain)"
  else
    echo "  ⚠ Setup failed. Run 'npm run setup-encryption' manually."
  fi
  return 0
}

echo ""
echo "Installing dependencies..."
cd "$ORCH_DIR"
npm install
npm run build

# Register porch CLI globally (porch workflow, porch list, etc.)
if npm link 2>/dev/null; then
  echo "  ✓ porch CLI available (run 'porch help')"
else
  echo "  ⚠ Could not link porch. Use: cd $ORCH_DIR && npm link"
  echo "    Or run: npx porch help (from $ORCH_DIR)"
fi

setup_encrypted_secrets

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
if [ "$(uname)" = "Darwin" ]; then
  for plist in "$HOME/Library/LaunchAgents/com.porch.server.plist" "$HOME/Library/LaunchAgents/com.mcp-orchestrator.server.plist"; do
    if [ -f "$plist" ]; then
      launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
      break
    fi
  done
else
  for svc in porch.service mcp-orchestrator.service; do
    if [ -f "$HOME/.config/systemd/user/$svc" ]; then
      systemctl --user stop "$svc" 2>/dev/null || true
      break
    fi
  done
fi

# Start server in background (keychain is read automatically at startup)
echo ""
echo "Starting Porch in background..."
cd "$ORCH_DIR"

if [ "$NO_STARTUP" = true ]; then
  nohup node build/server.js > "$ORCH_DIR/.porch.log" 2>&1 &
  echo $! > "$PID_FILE"
else
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
  fi
fi

sleep 1
SERVER_OK=false
if [ "$NO_STARTUP" = true ]; then
  if kill -0 $(cat "$PID_FILE") 2>/dev/null; then SERVER_OK=true; fi
elif [ "$(uname)" = "Darwin" ]; then
  launchctl list 2>/dev/null | grep -q com.porch.server && SERVER_OK=true
else
  systemctl --user is-active porch.service &>/dev/null && SERVER_OK=true
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
  echo "CLI:    porch help   (run workflows from terminal)"
  echo "To stop: ./scripts/stop.sh"
  echo "Logs:   tail -f $ORCH_DIR/.porch.log"
else
  echo "  ⚠ Server may have failed to start. Check: $ORCH_DIR/.porch.log"
  rm -f "$PID_FILE"
  exit 1
fi
