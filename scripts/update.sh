#!/usr/bin/env bash
# Update MCP Orchestrator: git pull, npm install, npm run build, restart server

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORCH_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "MCP Orchestrator — updater"
echo "=========================="

# Find git root (handles monorepo)
GIT_ROOT="$(git -C "$ORCH_DIR" rev-parse --show-toplevel 2>/dev/null)" || GIT_ROOT="$ORCH_DIR"

# Stop server
echo ""
echo "Stopping server..."
"$SCRIPT_DIR/stop.sh" 2>/dev/null || true
sleep 1

# Update
echo ""
echo "Pulling latest changes..."
cd "$GIT_ROOT"
git pull --rebase 2>/dev/null || git pull 2>/dev/null || { echo "  ⚠ git pull failed (not a git repo?)"; exit 1; }

echo ""
echo "Installing dependencies..."
cd "$ORCH_DIR"
npm install
npm run build

# Start server
echo ""
echo "Starting server..."
"$SCRIPT_DIR/start.sh"

echo ""
echo "✓ Update complete."
