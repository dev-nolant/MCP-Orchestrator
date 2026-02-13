#!/usr/bin/env bash
# Stop MCP Orchestrator background server (nohup or launchd/systemd)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORCH_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_FILE="$ORCH_DIR/.mcp-orchestrator.pid"

STOPPED=false

# Check launchd (Mac)
if [ "$(uname)" = "Darwin" ] && [ -f "$HOME/Library/LaunchAgents/com.mcp-orchestrator.server.plist" ]; then
  if launchctl list 2>/dev/null | grep -q com.mcp-orchestrator.server; then
    launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.mcp-orchestrator.server.plist" 2>/dev/null || true
    echo "Stopped MCP Orchestrator (launchd)"
    STOPPED=true
  fi
fi

# Check systemd (Linux)
if [ -f "$HOME/.config/systemd/user/mcp-orchestrator.service" ]; then
  if systemctl --user is-active mcp-orchestrator.service &>/dev/null; then
    systemctl --user stop mcp-orchestrator.service 2>/dev/null || true
    echo "Stopped MCP Orchestrator (systemd)"
    STOPPED=true
  fi
fi

# Fall back to PID file (nohup)
if [ "$STOPPED" = false ] && [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    echo "Stopped MCP Orchestrator (PID $PID)"
    STOPPED=true
  fi
  rm -f "$PID_FILE"
fi

if [ "$STOPPED" = false ]; then
  echo "MCP Orchestrator is not running."
fi
