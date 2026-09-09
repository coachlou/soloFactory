#!/usr/bin/env bash
# build-distro-docs.sh — copy the dev-workspace install runbook into the distro
# package. docs/INSTALL.md is the source of truth; distro/INSTALL.md is a build
# artifact vendored alongside it so the ambient-library sync picks it up.
set -euo pipefail
cd "$(dirname "$0")/.."
cp docs/INSTALL.md distro/INSTALL.md
