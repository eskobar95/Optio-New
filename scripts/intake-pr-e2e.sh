#!/usr/bin/env bash
# Prove intake → GitHub pull request on a running orchestrator.
#
# Skips unless INTAKE_PR_E2E=1, so CI and hello-world stay green.
# Task ids must match e2e-[a-z0-9-]+. The script does not merge.
#
# Host sequence (checkout /opt/optio-new, sops env already in place):
#   bash scripts/secrets.sh compose --profile orchestrator up -d --build orchestrator
#   INTAKE_PR_E2E=1 bash scripts/secrets.sh run -- bash scripts/intake-pr-e2e.sh
#
# secrets.sh run exports the decrypted env into the script. The script reads
# OPTIO_NEW_GITHUB_TOKEN and OPTIO_NEW_GITHUB_REPO and does not print them.
# The Cursor CLI (agent, or CURSOR_AGENT_BIN) must be on PATH inside the
# orchestrator container. A missing binary fails the coding step (cli_not_found).
# createEnvModelAdapter performs no HTTP. Planner steps use CURSOR_API_KEY.
#
# Close the pull request and delete the remote branch when you are done:
#   gh pr close <url> --delete-branch
# e2e- tasks are left unmerged by the orchestrator.
set -euo pipefail

pass() { echo "[intake-pr] PASS: $*"; }
fail() { echo "[intake-pr] FAIL: $*" >&2; exit 1; }
skip() { echo "[intake-pr] SKIP: $*"; }

if [[ "${INTAKE_PR_E2E:-0}" != "1" ]]; then
  skip "set INTAKE_PR_E2E=1 to post intake and poll GitHub (docs/pipeline.md)"
  exit 0
fi

base="${ORCHESTRATOR_URL:-http://127.0.0.1:3100}"
base="${base%/}"
repo="${OPTIO_NEW_GITHUB_REPO:-}"
token="${OPTIO_NEW_GITHUB_TOKEN:-}"
timeout="${INTAKE_PR_E2E_TIMEOUT_SECS:-900}"
task_id="${INTAKE_PR_E2E_TASK_ID:-e2e-$(date +%s)-${RANDOM}}"

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v node >/dev/null 2>&1 || fail "node is required"
[[ "$task_id" =~ ^e2e-[a-z0-9-]+$ ]] || fail "task id must match e2e-[a-z0-9-]+ (got ${task_id})"
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "OPTIO_NEW_GITHUB_REPO must be owner/repo"
[[ -n "$token" ]] || fail "OPTIO_NEW_GITHUB_TOKEN is required"
[[ "$timeout" =~ ^[0-9]+$ ]] || fail "INTAKE_PR_E2E_TIMEOUT_SECS must be a number"

owner="${repo%%/*}"
netrc="$(mktemp)"
chmod 600 "$netrc"
trap 'rm -f "$netrc"' EXIT
printf 'machine api.github.com login x-access-token password %s\n' "$token" >"$netrc"
unset token

if ! curl -fsS --max-time 3 "${base}/health" >/dev/null 2>&1; then
  fail "orchestrator ${base}/health is down. Start: bash scripts/secrets.sh compose --profile orchestrator up -d --build orchestrator"
fi

payload="$(node --input-type=module -e 'process.stdout.write(JSON.stringify({
  brief: {
    title: "e2e intake pr",
    description: "Throwaway intake proof. Open a pull request only. Do not merge.",
  },
  metadata: { taskId: process.argv[1], sessionId: process.argv[1] },
}))' "$task_id")"

accepted="$(curl -fsS --max-time 10 -X POST "${base}/intake" \
  -H 'content-type: application/json' \
  -d "$payload")" || fail "POST ${base}/intake"
node --input-type=module -e '
const body = JSON.parse(process.argv[1]);
const taskId = process.argv[2];
if (body.taskId !== taskId || body.queue !== "optio.plan") process.exit(1);
' "$accepted" "$task_id" || fail "POST /intake body did not accept ${task_id}"
pass "POST /intake taskId=${task_id}"

deadline=$((SECONDS + timeout))
found=""
while (( SECONDS < deadline )); do
  body="$(curl -sS --max-time 15 --netrc-file "$netrc" \
    -H "Accept: application/vnd.github+json" \
    -H "User-Agent: optio-new-intake-pr-e2e" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/${repo}/pulls?head=${owner}:task/${task_id}&state=open" || true)"
  if [[ -n "$body" ]]; then
    found="$(node --input-type=module -e '
const raw = process.argv[1];
const taskId = process.argv[2];
let body;
try { body = JSON.parse(raw); } catch { process.exit(2); }
if (!Array.isArray(body)) process.exit(2);
const head = `task/${taskId}`;
const pr = body.find((item) => item && item.head && item.head.ref === head && typeof item.html_url === "string");
if (!pr || !String(pr.html_url).includes("/pull/")) process.exit(3);
process.stdout.write(pr.html_url);
' "$body" "$task_id" || true)"
  fi
  if [[ -n "$found" ]]; then
    pass "pull request ${found}"
    echo "[intake-pr] e2e tasks stay unmerged. Close it when finished: gh pr close ${found} --delete-branch"
    exit 0
  fi
  sleep 5
done

fail "no open pull request with head task/${task_id} on ${repo} within ${timeout}s. Coding steps fail closed when CURSOR_API_KEY or the agent binary is missing."
