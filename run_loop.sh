#!/usr/bin/env bash
set -uo pipefail

MAX=100
LOGS_DIR="logs"
mkdir -p "$LOGS_DIR"
LOGFILE="$LOGS_DIR/codex_loop_$(date +%Y%m%d_%H%M%S).log"

for i in $(seq 1 "$MAX"); do
  echo "===== Iteration $i/$MAX ($(date '+%F %T')) =====" | tee -a "$LOGFILE"

  codex exec --sandbox danger-full-access "read on loop.md and do works" \
    2>&1 | tee -a "$LOGFILE"
  rc=${PIPESTATUS[0]}

  echo "[exit=$rc]" | tee -a "$LOGFILE"

  if [ "$rc" -ne 0 ]; then
    echo ">>> Iteration $i FAILED. Stopping. Last state is in $LOGFILE" | tee -a "$LOGFILE"
    exit "$rc"
  fi
done

echo ">>> All $MAX iterations completed. Log: $LOGFILE"