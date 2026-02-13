#!/usr/bin/env bash
# Start MCP Orchestrator in background (Mac & Linux)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORCH_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_FILE="$ORCH_DIR/.mcp-orchestrator.pid"
PORT="${PORT:-3847}"

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "MCP Orchestrator is already running (PID $PID)"
    echo "  http://mcporch.local:$PORT or http://localhost:$PORT"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

cd "$ORCH_DIR"
nohup node build/server.js > "$ORCH_DIR/.mcp-orchestrator.log" 2>&1 &
echo $! > "$PID_FILE"
echo "Started MCP Orchestrator (PID $(cat "$PID_FILE"))"
echo "  http://mcporch.local:$PORT or http://localhost:$PORT"
