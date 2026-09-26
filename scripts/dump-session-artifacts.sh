#!/usr/bin/env bash
# Print the session artifact trail for a task. Uses the orchestrator HTTP API.
# Does not read docker logs and does not print secrets.
set -euo pipefail

TASK="${1:-}"
SESSION="${2:-$TASK}"
PORT="${ORCHESTRATOR_PORT:-3100}"
BASE="${OPTIO_NEW_ORCHESTRATOR_URL:-http://127.0.0.1:${PORT}}"

if [[ -z "$TASK" ]]; then
  echo "usage: dump-session-artifacts.sh <taskId> [sessionId]" >&2
  exit 2
fi
if [[ "$TASK" == *:* || "$SESSION" == *:* ]]; then
  echo "taskId and sessionId must not contain ':'" >&2
  exit 2
fi
if [[ ! "$TASK" =~ ^[A-Za-z0-9._-]+$ || ! "$SESSION" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "taskId and sessionId must match [A-Za-z0-9._-]+" >&2
  exit 2
fi

curl -fsS -G "${BASE}/tasks/${TASK}/artifacts" --data-urlencode "sessionId=${SESSION}"
echo
