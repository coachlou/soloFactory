#!/usr/bin/env bash
# Re-snapshot a run whenever its event log or state changes (checked every second), and at least once a minute
# so "quiet for" keeps counting. Usage: run-dashboard/watch.sh <run dir> [out dir]
RUN="$1"; OUT="${2:-$(dirname "$0")/live-data}"; last=""; tick=0
while :; do
  sig=$(stat -f '%m %z' "$RUN/events.jsonl" "$RUN/state.json" 2>/dev/null | tr '\n' ' ')
  if [[ "$sig" != "$last" || $tick -ge 60 ]]; then
    python3 "$(dirname "$0")/extract.py" "$RUN" "$OUT" 2>/dev/null; last="$sig"; tick=0
  fi
  sleep 1; tick=$((tick + 1))
done
