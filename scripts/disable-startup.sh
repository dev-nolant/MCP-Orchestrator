#!/usr/bin/env bash
# Disable Porch auto-start on login.
# Stops the server and removes it from launchd/systemd.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORCH_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/com.porch.server.plist"
PLIST_LEGACY="$HOME/Library/LaunchAgents/com.mcp-orchestrator.server.plist"
SVC="$HOME/.config/systemd/user/porch.service"
SVC_LEGACY="$HOME/.config/systemd/user/mcp-orchestrator.service"

# Stop first
"$SCRIPT_DIR/stop.sh"

if [ "$(uname)" = "Darwin" ]; then
  if [ -f "$PLIST" ]; then
    launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Auto-start disabled (removed launchd plist)"
  elif [ -f "$PLIST_LEGACY" ]; then
    launchctl bootout "gui/$(id -u)" "$PLIST_LEGACY" 2>/dev/null || true
    rm -f "$PLIST_LEGACY"
    echo "Auto-start disabled (removed legacy launchd plist)"
  else
    echo "Auto-start was not enabled."
  fi
else
  if [ -f "$SVC" ]; then
    systemctl --user disable porch.service 2>/dev/null || true
    rm -f "$SVC"
    systemctl --user daemon-reload 2>/dev/null || true
    echo "Auto-start disabled (removed systemd service)"
  elif [ -f "$SVC_LEGACY" ]; then
    systemctl --user disable mcp-orchestrator.service 2>/dev/null || true
    rm -f "$SVC_LEGACY"
    systemctl --user daemon-reload 2>/dev/null || true
    echo "Auto-start disabled (removed legacy systemd service)"
  else
    echo "Auto-start was not enabled."
  fi
fi
