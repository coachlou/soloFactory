#!/usr/bin/env bash
# build-distro.sh — assemble and verify the distro/ package that ambient-library syncs.
#
#   bash scripts/build-distro.sh          # copy docs/INSTALL.md → distro/INSTALL.md, then verify
#   bash scripts/build-distro.sh --check  # verify only (npm test runs this); exit 1 on any gap
#
# Verifies that (1) every distro file the installer/skill relies on exists, (2) every path in
# APP_FILES exists, (3) every directory src/ reads relative to the app root is listed in
# APP_FILES — a new runtime asset that isn't shipped fails here instead of on a member's machine.
set -euo pipefail
cd "$(dirname "$0")/.."
CHECK=0; [ "${1:-}" = "--check" ] && CHECK=1
if [ $CHECK = 0 ]; then cp docs/INSTALL.md distro/INSTALL.md; fi
fail=0; miss() { echo "distro: $*" >&2; fail=1; }

for f in SKILL.md instructions.md INSTALL.md run.sh APP_FILES DEPENDS .claude-plugin/plugin.json \
         install.d/post.sh templates/aai/identity.md templates/aai/context.md templates/aai/instructions.md; do
  [ -e "distro/$f" ] || miss "missing distro/$f"
done
cmp -s docs/INSTALL.md distro/INSTALL.md || miss "distro/INSTALL.md is stale — run scripts/build-distro.sh"

while read -r p; do [ -z "$p" ] || [ -e "$p" ] || miss "APP_FILES lists $p but it does not exist"; done < distro/APP_FILES

# Directories the app reads from its own root at runtime: path.join(projectRoot, "x") and "..", "x".
# ponytail: a grep, not a parser — extend the pattern if src/ grows a new way to reach the root.
for d in $(grep -ohE '(projectRoot|"\.\."), "[A-Za-z0-9_.-]+"' src/*.mjs | sed -E 's/.*"([^"]+)"$/\1/' | sort -u); do
  case "$d" in .*) continue;; esac  # dot-paths are runtime state, written not shipped
  grep -qx "$d" distro/APP_FILES || miss "src/ reads '$d' from the app root but APP_FILES does not ship it"
done

[ $fail = 0 ] && echo "distro: ok ($(wc -l < distro/APP_FILES | tr -d ' ') app paths, INSTALL.md in sync)"
exit $fail
