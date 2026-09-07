#!/usr/bin/env bash
# run.sh — start SoloFactory for the ambient folder this capability is vendored into.
#
#   bash run.sh            # http://127.0.0.1:4173
#   PORT=5000 bash run.sh
#   SOLOFACTORY_DEMO=1 bash run.sh   # deterministic demo, no subscription quota used
#
# Resolves the folder by walking up to the nearest .aai/, so it works from
# .ailib/solofactory/ and from a fork in .aai/skills/solofactory/ alike.
# Projects are git repos in <folder>/projects/<name>; the interview log in <folder>/.aai/memory/solofactory/.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FOLDER="$HERE"
while [ ! -d "$FOLDER/.aai" ]; do
  [ "$FOLDER" = "/" ] && { echo "no .aai/ above $HERE — run install.sh first" >&2; exit 1; }
  FOLDER="$(dirname "$FOLDER")"
done
command -v node >/dev/null || { echo "node 22+ is required" >&2; exit 1; }
mkdir -p "$FOLDER/projects" "$FOLDER/.aai/memory/solofactory"
export SOLOFACTORY_HOME="${SOLOFACTORY_HOME:-$FOLDER/.aai/memory/solofactory}"
export SOLOFACTORY_ROOT="${SOLOFACTORY_ROOT:-$FOLDER}"
echo "SoloFactory → http://127.0.0.1:${PORT:-4173}   projects: $SOLOFACTORY_ROOT/{*,projects/*}"
exec node "$HERE/app/src/server.mjs"
