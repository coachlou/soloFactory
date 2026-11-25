#!/usr/bin/env bash
# Run a long job (smoke set, real run) so it outlives the agent session that started it.
#
#   bash scripts/detached.sh <log> <command> [args...]
#
# The job gets its own session (setsid), ignores hangup, and keeps the Mac awake while it runs (caffeinate -i).
# Output goes to <log>; when it ends, <log>.exit holds its exit code. Any later session checks progress with
#   tail <log>; cat <log>.exit 2>/dev/null || echo still running   (pid in <log>.pid)
# ponytail: no restart on reboot; a power cut still kills it, and <log>.exit is then missing with a dead pid.
set -euo pipefail
[ $# -ge 2 ] || { echo "usage: detached.sh <log> <command> [args...]" >&2; exit 2; }
log=$1; shift
rm -f "$log.exit"
nohup python3 -c '
import os, sys, subprocess
os.setsid()
log = sys.argv[1]
with open(log, "ab") as out:
    code = subprocess.call(["caffeinate", "-i", *sys.argv[2:]], stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
open(log + ".exit", "w").write(f"{code}\n")
' "$log" "$@" >/dev/null 2>&1 &
echo $! > "$log.pid"
echo "detached pid $(cat "$log.pid"), log $log"
