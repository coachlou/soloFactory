#!/usr/bin/env bash
# post.sh — solofactory-specific install steps; run by ambient-folder/install.sh with TARGET and CAP_DIR set.
set -euo pipefail
mkdir -p "$TARGET/projects"
command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] \
  || echo "  warn  node 22+ not found on PATH — SoloFactory will not start until it is installed"
echo "start:  bash '$CAP_DIR/run.sh'   → http://127.0.0.1:4173"
