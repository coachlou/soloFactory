#!/usr/bin/env bash
# post.sh — solofactory-specific install steps; run by ambient-folder/install.sh with TARGET and CAP_DIR set.
set -euo pipefail
mkdir -p "$TARGET/projects"
# ponytail: root-level launcher so nobody types the .ailib path; always rewritten, it only delegates.
# Resolves .aai/skills first so a personalized fork (shadowing) still wins.
cat > "$TARGET/start.sh" <<'SH'
#!/usr/bin/env bash
# start.sh — launch SoloFactory for this folder. PORT=5000 and SOLOFACTORY_DEMO=1 pass through.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="$HERE/.aai/skills/solofactory/run.sh"; [ -f "$RUN" ] || RUN="$HERE/.ailib/solofactory/run.sh"
exec bash "$RUN" "$@"
SH
chmod +x "$TARGET/start.sh"
# Node 24 and 26 LTS: same rule as src/node-version.mjs. Warn only; nothing here stops an install.
SUPPORTED="24 26"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "  warn  node 22+ not found on PATH — SoloFactory will not start until Node 26 LTS (or 24) is installed (see INSTALL.md A4 / B3)"
elif ! [[ " $SUPPORTED " == *" $NODE_MAJOR "* ]]; then
  # ponytail: untested majors can lack prebuilds for native packages. Change SUPPORTED, .nvmrc, engines and CI together.
  echo "  warn  node $NODE_MAJOR is not supported by SoloFactory (Node 24 or 26 LTS) — install Node 26 LTS (see INSTALL.md A4 / B3)"
fi
echo "start:  bash '$TARGET/start.sh'   → http://127.0.0.1:4173"
