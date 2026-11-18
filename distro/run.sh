#!/usr/bin/env bash
# run.sh — start SoloFactory for the ambient folder this capability is vendored into.
#
#   bash run.sh            # http://127.0.0.1:4173
#   PORT=5000 bash run.sh
#   SOLOFACTORY_DEMO=1 bash run.sh   # deterministic demo, no subscription quota used
#
# Resolves the folder by walking up to the nearest .aai/, so it works from
# .ailib/solofactory/ and from a fork in .aai/skills/solofactory/ alike.
# Projects live in <folder>/projects/<name> (each with its own .aai/); <folder>/.aai/memory/solofactory/ only remembers the active one.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FOLDER="$HERE"
while [ ! -d "$FOLDER/.aai" ]; do
  [ "$FOLDER" = "/" ] && { echo "no .aai/ above $HERE — run install.sh first" >&2; exit 1; }
  FOLDER="$(dirname "$FOLDER")"
done
# Node 24 and 26 LTS: same rule as src/node-version.mjs. Below 22 cannot run; the server warns on any other major.
SUPPORTED="24 26"
command -v node >/dev/null || { echo "node 22+ is required — install Node 26 LTS (see INSTALL.md A4 / B3)" >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || { echo "node 22+ is required (found $(node --version)) — install Node 26 LTS (see INSTALL.md A4 / B3)" >&2; exit 1; }
mkdir -p "$FOLDER/projects" "$FOLDER/.aai/memory/solofactory"
export SOLOFACTORY_HOME="${SOLOFACTORY_HOME:-$FOLDER/.aai/memory/solofactory}"
export SOLOFACTORY_ROOT="${SOLOFACTORY_ROOT:-$FOLDER}"
# Feedback reports offer GitHub issue links as well as email. Set it empty to hide the links.
export SOLOFACTORY_ISSUES_URL="${SOLOFACTORY_ISSUES_URL-https://github.com/coachlou/soloFactory/issues}"
echo "SoloFactory → http://127.0.0.1:${PORT:-4173}   projects: $SOLOFACTORY_ROOT/{*,projects/*}"
exec node "$HERE/app/src/server.mjs"
