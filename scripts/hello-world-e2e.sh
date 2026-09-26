#!/usr/bin/env bash
# Prove intake → plan on a running orchestrator (loopback :3100).
#
# On the kit-harness host:
#   docker compose --profile full --profile harness up -d --build orchestrator
#   HELLO_WORLD_E2E=1 bash scripts/hello-world-e2e.sh
#
# Profile `full` starts the orchestrator (and the eve-runner stub) beside redis
# and postgres. kit-harness itself is profile `harness` on :3200 and is not
# required for this check. Compose publishes 3100 on 127.0.0.1 only.
#
# Without a listener the script skips, so `npm run ci` stays green.
# HELLO_WORLD_E2E=1 turns that skip into a failure.
set -euo pipefail

pass() { echo "[hello-world] PASS: $*"; }
fail() { echo "[hello-world] FAIL: $*" >&2; exit 1; }
skip() { echo "[hello-world] SKIP: $*"; }

base="${ORCHESTRATOR_URL:-http://127.0.0.1:3100}"
base="${base%/}"
require="${HELLO_WORLD_E2E:-0}"

if ! command -v curl >/dev/null 2>&1; then
  if [[ "$require" == "1" ]]; then
    fail "curl is required"
  fi
  skip "curl absent"
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  if [[ "$require" == "1" ]]; then
    fail "node is required"
  fi
  skip "node absent"
  exit 0
fi

if ! curl -fsS --max-time 3 "${base}/health" >/dev/null 2>&1; then
  if [[ "$require" == "1" ]]; then
    fail "orchestrator ${base}/health is down. Start: docker compose --profile full --profile harness up -d --build orchestrator"
  fi
  skip "orchestrator not listening at ${base} (docker compose --profile full --profile harness up -d --build orchestrator; HELLO_WORLD_E2E=1 bash scripts/hello-world-e2e.sh)"
  exit 0
fi

hello="$(curl -fsS --max-time 3 "${base}/hello")" || fail "GET ${base}/hello"
node --input-type=module -e '
const body = JSON.parse(process.argv[1]);
if (body.ok !== true || body.hello !== "world" || body.stage !== "plan" || body.queue !== "optio.plan") {
  process.exit(1);
}
' "$hello" || fail "GET /hello body: ${hello}"
pass "GET /hello"

task_id="hw${EPOCHSECONDS:-0}${RANDOM}"
payload="$(node --input-type=module -e 'process.stdout.write(JSON.stringify({
  brief: { title: "hello", description: "world" },
  metadata: { taskId: process.argv[1], sessionId: process.argv[1] },
}))' "$task_id")"

accepted="$(curl -fsS --max-time 5 -X POST "${base}/intake" \
  -H 'content-type: application/json' \
  -d "$payload")" || fail "POST ${base}/intake"
node --input-type=module -e '
const body = JSON.parse(process.argv[1]);
const taskId = process.argv[2];
if (body.taskId !== taskId || body.sessionId !== taskId || body.queue !== "optio.plan" || body.jobId !== `${taskId}__plan`) {
  process.exit(1);
}
' "$accepted" "$task_id" || fail "POST /intake body: ${accepted}"
pass "POST /intake taskId=${task_id}"

progressed=0
last=""
for _ in $(seq 1 40); do
  last="$(curl -fsS --max-time 3 "${base}/hello/plan?taskId=${task_id}&sessionId=${task_id}")" \
    || fail "GET /hello/plan"
  if node --input-type=module -e '
const body = JSON.parse(process.argv[1]);
const taskId = process.argv[2];
if (
  body.progressed === true &&
  body.status === "completed" &&
  body.stage === "plan" &&
  body.hello === "world" &&
  body.taskId === taskId &&
  body.nextStepIndex === 2
) {
  process.exit(0);
}
process.exit(1);
' "$last" "$task_id"; then
    progressed=1
    break
  fi
  sleep 0.25
done

[[ "$progressed" == "1" ]] || fail "plan stage did not complete: ${last}"
pass "plan stage completed"
