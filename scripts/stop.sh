#!/usr/bin/env bash
# Stop Porch background server (nohup or launchd/systemd)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORCH_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_FILE="$ORCH_DIR/.porch.pid"

STOPPED=false

# Check launchd (Mac) - porch and legacy
for plist in "$HOME/Library/LaunchAgents/com.porch.server.plist" "$HOME/Library/LaunchAgents/com.mcp-orchestrator.server.plist"; do
  if [ -f "$plist" ] && launchctl list 2>/dev/null | grep -q "$(basename "$plist" .plist)"; then
    launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
    echo "Stopped Porch (launchd)"
    STOPPED=true
    break
  fi
done

# Check systemd (Linux) - porch and legacy
for svc in porch.service mcp-orchestrator.service; do
  if [ -f "$HOME/.config/systemd/user/$svc" ] && systemctl --user is-active "$svc" &>/dev/null; then
    systemctl --user stop "$svc" 2>/dev/null || true
    echo "Stopped Porch (systemd)"
    STOPPED=true
    break
  fi
done

# Fall back to PID file (nohup)
if [ "$STOPPED" = false ] && [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    echo "Stopped Porch (PID $PID)"
    STOPPED=true
  fi
  rm -f "$PID_FILE"
fi

if [ "$STOPPED" = false ]; then
  echo "Porch is not running."
fi
