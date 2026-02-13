#!/usr/bin/env bash
# Bootstrap: clone repo and run installer. Use with curl for one-line install.
# One-liner (Mac/Linux):
#   curl -sSL https://raw.githubusercontent.com/dev-nolant/MCP-Orchestrator/main/scripts/bootstrap.sh | bash
#
# With --no-startup:
#   curl -sSL https://raw.githubusercontent.com/dev-nolant/MCP-Orchestrator/main/scripts/bootstrap.sh | bash -s -- --no-startup
#
# For monorepo (mcp-orchestrator as subdir): set SUBDIR=mcp-orchestrator

set -e

GITHUB_REPO="${GITHUB_REPO:-https://github.com/dev-nolant/MCP-Orchestrator.git}"
DEST="${DEST:-$HOME/mcp-orchestrator}"
SUBDIR="${SUBDIR:-}"

echo "MCP Orchestrator — bootstrap"
echo "Cloning to $DEST ..."

if [ -d "$DEST" ]; then
  echo "Directory exists. Updating..."
  (cd "$DEST" && git pull --depth 1 2>/dev/null) || true
else
  git clone --depth 1 "$GITHUB_REPO" "$DEST"
fi

cd "$DEST"
[ -n "$SUBDIR" ] && cd "$SUBDIR"
chmod +x scripts/*.sh
./scripts/install.sh "$@"
