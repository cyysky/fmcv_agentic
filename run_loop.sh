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

  # Push this round's commits to the remote if the PAT secret exists; skip otherwise.
  SECRET_FILE="${SECRET_FILE:-.secrets/github_pat}"
  if [ -f "$SECRET_FILE" ] && [ -s "$SECRET_FILE" ]; then
    REMOTE_URL="$(git remote get-url origin 2>/dev/null || true)"
    if [ -n "$REMOTE_URL" ]; then
      PAT="$(cat "$SECRET_FILE")"
      CURRENT_BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null || echo main)"
      PUSH_URL="$(printf '%s' "$REMOTE_URL" | sed "s#^https://#https://x-access-token:${PAT}@#")"
      git push "$PUSH_URL" "HEAD:refs/heads/${CURRENT_BRANCH}" 2>&1 | tee -a "$LOGFILE"
      push_rc=${PIPESTATUS[0]}
      if [ "$push_rc" -eq 0 ]; then
        echo "[push=ok]" | tee -a "$LOGFILE"
      else
        echo "[push=failed]" | tee -a "$LOGFILE"
      fi
    else
      echo "[push=skipped: remote not configured]" | tee -a "$LOGFILE"
    fi
  else
    echo "[push=skipped: no secret found]" | tee -a "$LOGFILE"
  fi

  # Stop when the latest handoff says the loop is finished (LOOP.md exit
  # conditions) unless a newer human direction has arrived in DIRECTION.md.
  if grep -qE '^Loop state: finished' ROUND.md 2>/dev/null \
     && { [ ! -f DIRECTION.md ] || [ ROUND.md -nt DIRECTION.md ]; }; then
    echo ">>> Loop finished per ROUND.md handoff (exit conditions met). Stopping." | tee -a "$LOGFILE"
    break
  fi
done

echo ">>> All $MAX iterations completed. Log: $LOGFILE"
