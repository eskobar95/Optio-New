#!/usr/bin/env bash
# Refresh docs/status.md using gh (issues + latest CI conclusion).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
OUT="$ROOT/docs/status.md"
NOW="$(date '+%Y-%m-%d %H:%M %Z')"

REPO="${GITHUB_REPOSITORY:-}"
if [[ -z "$REPO" ]]; then
  REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "eskobar95/Optio-New")"
fi

CI_CONCLUSION="unknown"
CI_URL="https://github.com/${REPO}/actions/workflows/ci.yml"
if command -v gh >/dev/null 2>&1; then
  CI_CONCLUSION="$(gh run list --workflow=ci.yml --limit 1 --json conclusion -q '.[0].conclusion' 2>/dev/null || echo unknown)"
  if [[ -z "$CI_CONCLUSION" || "$CI_CONCLUSION" == "null" ]]; then
    CI_CONCLUSION="unknown"
  fi
fi

ISSUES_MD="- (none or gh unavailable)"
if command -v gh >/dev/null 2>&1; then
  TMP="$(gh issue list --state open --limit 20 --json number,title,labels \
    --jq '.[] | "- #\(.number) \(.title) (\([.labels[].name] | join(", ")))"' 2>/dev/null || true)"
  if [[ -n "${TMP}" ]]; then
    ISSUES_MD="$TMP"
  else
    ISSUES_MD="- (no open issues)"
  fi
fi

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
  echo "| Full BullMQ hello-world workers | Pending |"
  echo "| Real model providers / GPU / Vercel key | Pending (secrets local only) |"
  echo
  echo "## CI"
  echo
  echo "[![CI](https://github.com/${REPO}/actions/workflows/ci.yml/badge.svg)](https://github.com/${REPO}/actions/workflows/ci.yml)"
  echo
  echo "Latest conclusion: **${CI_CONCLUSION}**"
  echo
  echo "Actions: ${CI_URL}"
  echo
  echo "## Open issues"
  echo
  echo "${ISSUES_MD}"
  echo
  echo "## Structure overview"
  echo
  echo '```text'
  echo "Optio-New/"
  echo "  src/           # TypeScript harness (intake, jobs, adapters, gateway)"
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
} > "$OUT"

echo "Updated $OUT"

if command -v npx >/dev/null 2>&1; then
  npx prettier --write "$OUT" >/dev/null 2>&1 || true
fi
