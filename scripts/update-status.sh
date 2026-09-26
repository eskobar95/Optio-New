#!/usr/bin/env bash
# Refresh docs/status.md with the CI badge and an open-issue overview.
#
# Manual:
#   gh auth login
#   npm run status
#
# Idempotent: docs/status.md is rewritten only when the latest CI conclusion
# or the open-issue list changes. The "Last refreshed" line stays put when
# nothing else moved, so a second run does not dirty the tree.
#
# Tests set STATUS_USE_FIXTURES=1 and pass STATUS_CI_CONCLUSION plus
# STATUS_ISSUES_MD. Optional: STATUS_OUT, STATUS_NOW.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OUT="${STATUS_OUT:-$ROOT/docs/status.md}"
NOW="${STATUS_NOW:-$(date '+%Y-%m-%d %H:%M %Z')}"
ISSUE_LIMIT=50

REPO="${GITHUB_REPOSITORY:-}"
if [[ -z "$REPO" ]]; then
  if [[ "${STATUS_USE_FIXTURES:-}" == "1" ]]; then
    REPO="eskobar95/Optio-New"
  else
    command -v gh >/dev/null 2>&1 || {
      echo "gh is required (or set GITHUB_REPOSITORY)" >&2
      exit 1
    }
    REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
  fi
fi

if [[ ! "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "invalid repository name: ${REPO}" >&2
  exit 1
fi

CI_URL="https://github.com/${REPO}/actions/workflows/ci.yml"
ISSUES_URL="https://github.com/${REPO}/issues"

overview_for_count() {
  local count="$1"
  if [[ "$count" -eq 0 ]]; then
    printf '%s\n' "Open: 0."
  elif [[ "$count" -eq "$ISSUE_LIMIT" && "${STATUS_USE_FIXTURES:-}" != "1" ]]; then
    printf '%s\n' "Open: ${count} shown (capped at ${ISSUE_LIMIT})."
  else
    printf '%s\n' "Open: ${count}."
  fi
}

if [[ "${STATUS_USE_FIXTURES:-}" == "1" ]]; then
  CI_CONCLUSION="${STATUS_CI_CONCLUSION:-unknown}"
  if [[ -z "${STATUS_ISSUES_MD:-}" ]]; then
    ISSUE_COUNT=0
    ISSUES_MD="- (no open issues)"
  else
    ISSUES_MD="$STATUS_ISSUES_MD"
    ISSUE_COUNT="$(printf '%s\n' "$ISSUES_MD" | grep -c '^- #' || true)"
  fi
else
  command -v gh >/dev/null 2>&1 || {
    echo "gh is required. Install GitHub CLI and run gh auth login." >&2
    exit 1
  }
  export GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"

  if [[ -n "${STATUS_CI_CONCLUSION:-}" ]]; then
    CI_CONCLUSION="$STATUS_CI_CONCLUSION"
  else
    CI_CONCLUSION="$(gh run list --repo "$REPO" --workflow=ci.yml --limit 1 --json conclusion --jq '.[0].conclusion // "unknown"')"
  fi

  ISSUES_MD="$(gh issue list --repo "$REPO" --state open --limit "$ISSUE_LIMIT" \
    --json number,title,labels \
    --jq '
      sort_by(-.number) | .[] |
      "- #\(.number) \(.title)" +
      (
        if (.labels | length) == 0 then ""
        else " (\([.labels[].name] | sort | join(", ")))"
        end
      )
    ')"

  if [[ -z "${ISSUES_MD}" ]]; then
    ISSUE_COUNT=0
    ISSUES_MD="- (no open issues)"
  else
    ISSUE_COUNT="$(printf '%s\n' "$ISSUES_MD" | grep -c '^- #' || true)"
  fi
fi

if [[ -z "$CI_CONCLUSION" || "$CI_CONCLUSION" == "null" ]]; then
  CI_CONCLUSION="unknown"
fi

OPEN_OVERVIEW="$(overview_for_count "$ISSUE_COUNT")"

TMP="$(mktemp "${TMPDIR:-/tmp}/optio-status.XXXXXX.md")"
cleanup() {
  rm -f "$TMP"
}
trap cleanup EXIT

{
  echo "# Optio-New — status"
  echo
  echo "Last refreshed: ${NOW}"
  echo
  echo "## Bootstrap progress"
  echo
  echo "| Area | Status |"
  echo "|------|--------|"
  echo "| In-repo \`.cursor/skills\` + \`.cursor/agents\` SoT | Done |"
  echo "| Linear stripped → New Bot intake + BullMQ | Done |"
  echo "| TypeScript \`src/\` + \`tests/\` + tooling (ESLint, Prettier, Vitest, Husky) | Done |"
  echo "| Public GitHub + CI on push/PR | Live |"
  echo "| Good first issue: \`src/agent/loop.ts\` | See open issues |"
  echo "| BullMQ stage graph (plan → merge) + Postgres step cursor | Orchestrator image: \`POST /intake\` and \`GET /health\` on :3100 |"
  echo "| Real model providers / GPU / Vercel key | Pending (secrets local only) |"
  echo "| kit-harness decision sidecar | Compose profile \`harness\` (rules engine; Jev not called) |"
  echo
  echo "## CI"
  echo
  echo "[![CI](https://github.com/${REPO}/actions/workflows/ci.yml/badge.svg)](${CI_URL})"
  echo
  echo "Latest conclusion: **${CI_CONCLUSION}**"
  echo
  echo "Actions: ${CI_URL}"
  echo
  echo "## Compose smoke (Docker Desktop or Linux)"
  echo
  echo "Issue [#23](https://github.com/${REPO}/issues/23). Runbook: [mac-compose-smoke.md](mac-compose-smoke.md). Command: \`bash scripts/smoke-compose-mac.sh\` (repo-root \`.env\`, or \`.env.example\` when \`.env\` is absent). Same path on Mac Docker Desktop and on Linux Docker, including kit-harness."
  echo
  echo "| Check | State |"
  echo "| --- | --- |"
  echo "| Compose config for redis, postgres, litellm | Scripted. CI runs \`--config-only\` when the Docker CLI is present, and always syntax-checks the script |"
  echo "| Isolated up/down (\`optio-new-mac-smoke\`, ports 16379/15432/14000) | Host-agnostic. kit-harness (Linux) full up/down PASSED 2026-09-26. GitHub Actions does not start the stack |"
  echo "| Failure issues | None filed. Mac Docker Desktop remains optional |"
  echo
  echo "Verified: kit-harness (Linux, Docker Compose) full \`bash scripts/smoke-compose-mac.sh\` PASSED on 2026-09-26 against \`7aa4b2e\` (redis PING, postgres pg_isready, litellm \`/health/liveliness\`, \`down -v\`). Project \`optio-new\` on 6379/5432/4000 stayed up. Config-only PASSED."
  echo
  echo "Gaps: LiteLLM tag \`ghcr.io/berriai/litellm:main-latest\` floats; profile \`full\` (orchestrator, eve-runner) stays out of this smoke; provider keys stay empty; the check is \`/health/liveliness\`, which does not call a model."
  echo
  echo "Orchestrator verify (profiles \`full\` and \`orchestrator\`; eve-runner is still a stub):"
  echo
  echo '```bash'
  echo "docker compose --profile full --profile harness up -d --build orchestrator"
  echo "HELLO_WORLD_E2E=1 bash scripts/hello-world-e2e.sh"
  echo '```'
  echo
  echo "\`GET /hello\` is the demo card. The script posts intake and polls \`GET /hello/plan\` until the plan cursor is \`completed\`. \`GET /health\` is 200 when Redis answers. Without a listener the script skips; \`HELLO_WORLD_E2E=1\` fails closed."
  echo
  echo "## Open issues"
  echo
  echo "${OPEN_OVERVIEW}"
  echo
  echo "Tracker: ${ISSUES_URL}"
  echo
  echo "${ISSUES_MD}"
  echo
  echo "## Refresh"
  echo
  echo "Manual refresh (GitHub CLI authenticated via \`gh auth login\`):"
  echo
  echo '```bash'
  echo "npm run status"
  echo '```'
  echo
  echo "The script is idempotent: this file is rewritten only when the latest CI conclusion or the open-issue list changes."
  echo
  echo "Automation: \`.github/workflows/status.yml\` runs the same script on a daily schedule, on \`workflow_dispatch\`, and after the CI workflow completes on \`main\`."
  echo
  echo "## Observability"
  echo
  echo "v1 agent UI is Langfuse; Phoenix is not wired. SigNoz is the infra OTLP sink. Both exporters default off. Decision: \`docs/observability.md\`."
  echo
  echo "Local pipeline trace (in-process OTel, exporters off):"
  echo
  echo '```json'
  cat "$ROOT/docs/traces/local-pipeline.json"
  echo '```'
  echo
  echo "## Structure overview"
  echo
  echo '```text'
  echo "Optio-New/"
  echo "  src/           # TypeScript harness (intake, jobs, adapters, gateway, kit-harness)"
  echo "  tests/         # Vitest"
  echo "  agents/        # Eve phase contracts"
  echo "  .cursor/       # Skills + specialist agents (SoT)"
  echo "  docs/          # SPEC.md, status.md"
  echo "  workflows/     # default-task.yaml"
  echo "  orchestrator/  # Domain READMEs (intake, jobs, …)"
  echo "  docker-compose.yml"
  echo '```'
  echo
  echo "Decision layer: **New Bot**. Pipeline: **BullMQ**. Linear: **out** (SPEC §8)."
  echo
  echo "## Decisions"
  echo
  echo "Caveman Cloud/Platform stays off for V1. Codex stays on local LiteLLM. Eval: [caveman-platform-eval.md](caveman-platform-eval.md) (issue #16)."
} >"$TMP"

PRETTIER="$ROOT/node_modules/.bin/prettier"
if [[ -x "$PRETTIER" ]]; then
  "$PRETTIER" --write "$TMP" --config "$ROOT/.prettierrc" >/dev/null
fi

snapshot_body() {
  grep -v '^Last refreshed:' "$1" || true
}

if [[ -f "$OUT" ]] && diff -q <(snapshot_body "$OUT") <(snapshot_body "$TMP") >/dev/null; then
  echo "Unchanged $OUT"
  exit 0
fi

mkdir -p "$(dirname "$OUT")"
cp "$TMP" "$OUT"
echo "Updated $OUT"
