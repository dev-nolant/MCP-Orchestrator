#!/usr/bin/env bash
# Bootstrap: clone repo and run installer. Use with curl for one-line install.
# One-liner (Mac/Linux):
#   curl -sSL https://raw.githubusercontent.com/porch-sh/porch/main/scripts/bootstrap.sh | bash
#
# With --no-startup:
#   curl -sSL https://raw.githubusercontent.com/porch-sh/porch/main/scripts/bootstrap.sh | bash -s -- --no-startup
#
# For monorepo (porch as subdir): set SUBDIR=porch

set -e

GITHUB_REPO="${GITHUB_REPO:-https://github.com/porch-sh/porch.git}"
DEST="${DEST:-$HOME/porch}"
SUBDIR="${SUBDIR:-}"

echo "Porch — bootstrap"
echo "  https://porch.sh — https://github.com/porch-sh/porch"
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
