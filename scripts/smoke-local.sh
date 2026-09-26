#!/usr/bin/env bash
# Optio-New local/CI smoke — fast checks; Docker optional.
#
# Docker-optional (this script, CI): node, secrets audit, typecheck, vitest, in-process
# kit-harness, and `docker compose config` when the CLI exists. Missing Docker is a SKIP.
# Compose is not started unless SMOKE_COMPOSE_UP=1, and that path only brings up redis + postgres.
#
# Docker-required (not started here): `docker compose --profile full --profile harness up -d`
# for redis, postgres, orchestrator, litellm, and kit-harness on 127.0.0.1:3200.
# Hello-world (skipped unless :3100 is already up): scripts/hello-world-e2e.sh posts
# /intake and polls GET /hello/plan. See README.md and docs/kit-harness.md.
# Eve-runner stays a stub.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

pass() { echo "[smoke] PASS: $*"; }
fail() { echo "[smoke] FAIL: $*" >&2; exit 1; }
skip() { echo "[smoke] SKIP: $*"; }

command -v node >/dev/null || fail "node not found"
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
[[ "$NODE_MAJOR" -ge 20 ]] || fail "need Node >= 20 (got $(node -v))"
pass "node $(node -v)"

echo "[smoke] Docker-optional path: node, secrets audit, typecheck, vitest, in-process kit-harness. Missing Docker is SKIP."
echo "[smoke] Docker-required path: docker compose --profile full --profile harness up -d (redis, postgres, orchestrator, litellm, kit-harness on 127.0.0.1:3200)."

# Paths and private-key markers only. Do not print env values.
bash scripts/secrets.sh audit || fail "secrets audit"
pass "secrets audit"

if [[ ! -d node_modules ]]; then
  npm install
else
  pass "node_modules present"
fi

npm run typecheck || fail "typecheck"
pass "typecheck"

npm test || fail "vitest"
pass "vitest"

eve_wt="$(mktemp -d)"
eve_input="$(mktemp)"
cat >"$eve_input" <<EOF
{
  "taskId": "smoke-eve",
  "stepId": "implementation",
  "worktreePath": "${eve_wt}",
  "agentId": "agents/implementation",
  "skillBudget": [],
  "specialistsAllowed": [],
  "codingBackend": "sandbox"
}
EOF
npx tsc -p tsconfig.eve.json || fail "eve-runner compile"
eve_out="$(node dist/src/eve/cli.js run --file "$eve_input")" || fail "eve-runner cli"
node --input-type=module -e 'const r=JSON.parse(process.argv[1]); if (r.graphAdvanced !== false || r.ok !== true) process.exit(1)' "$eve_out" || fail "eve-runner advanced the graph"
rm -rf "$eve_wt" "$eve_input"
pass "eve-runner cli"

bash -n "$ROOT/scripts/smoke-compose-mac.sh" || fail "smoke-compose-mac.sh syntax"
pass "smoke-compose-mac.sh syntax"

npx vitest run tests/security-gates.test.ts || fail "security gates"
pass "security gates (secrets deny, config lock, tool timeout)"

# kit-harness røgtest: health, routing, then three scenarios.
smoke_kit_harness() {
  local port="${KIT_HARNESS_SMOKE_PORT:-3217}"
  local base="http://127.0.0.1:${port}"
  local log pid
  log="$(mktemp)"
  pid=""
  cleanup() {
    if [[ -n "${pid}" ]]; then
      kill "${pid}" >/dev/null 2>&1 || true
      wait "${pid}" >/dev/null 2>&1 || true
      pid=""
    fi
    if [[ -n "${log}" && -f "${log}" ]]; then
      rm -f "${log}"
    fi
  }
  trap cleanup EXIT

  npx tsc -p tsconfig.kit-harness.json || fail "kit-harness tsc"
  KIT_HARNESS_HOST=127.0.0.1 KIT_HARNESS_PORT="${port}" node dist/main.js >"${log}" 2>&1 &
  pid=$!

  local ready=0
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if curl -sf "${base}/health" >/dev/null 2>&1; then
      ready=1
      break
    fi
    if ! kill -0 "${pid}" 2>/dev/null; then
      cat "${log}" >&2 || true
      fail "kit-harness exited before health"
    fi
    sleep 0.25
  done
  [[ "${ready}" == "1" ]] || { cat "${log}" >&2 || true; fail "kit-harness health"; }
  pass "kit-harness health"

  local route loop gate audit
  route="$(curl -sf "${base}/v1/route-model" -H 'content-type: application/json' \
    -d '{"cursor_quota_remaining":2,"codex_quota_remaining":2}')" \
    || { cat "${log}" >&2 || true; fail "model routing request"; }
  echo "${route}" | grep -q '"choice":"cursor_subscription"' || fail "model routing"
  pass "model routing"

  loop="$(curl -sf "${base}/v1/loop-detect" -H 'content-type: application/json' \
    -d '{"events":[{"fingerprint":"loop-1","tool":"shell","outcome":"fail"},{"fingerprint":"loop-2","tool":"shell","outcome":"fail"},{"fingerprint":"loop-3","tool":"shell","outcome":"fail"}]}')" \
    || { cat "${log}" >&2 || true; fail "loop detection request"; }
  echo "${loop}" | grep -q '"loop_detected":true' || fail "scenario 2 loop_detected"
  echo "${loop}" | grep -q '"halt":true' || fail "scenario 2 halt"
  echo "${loop}" | grep -q '"suggestion":"stop"' || fail "scenario 2 stop"
  pass "scenario 2 infinite loop halt"

  gate="$(curl -sf "${base}/v1/tool-gate" -H 'content-type: application/json' \
    -d '{"tool":"shell","context":{"command":"rm -rf /tmp/optio-smoke","agent_id":"smoke"}}')" \
    || { cat "${log}" >&2 || true; fail "forbidden tool request"; }
  echo "${gate}" | grep -q '"decision":"deny"' || fail "forbidden tool not denied"
  echo "${gate}" | grep -q '"reason":"hard_deny_destructive"' || fail "forbidden tool reason"
  pass "scenario 1 forbidden tool deny"

  audit="$(curl -sf "${base}/v1/audit")" \
    || { cat "${log}" >&2 || true; fail "audit request"; }
  echo "${audit}" | grep -q 'rm -rf /tmp/optio-smoke' || fail "audit missing rm -rf attempt"
  echo "${audit}" | grep -q '"decision":"deny"' || fail "audit missing deny"
  grep -q '"event":"tool_denied"' "${log}" || fail "structured deny log missing"
  grep -q 'rm -rf /tmp/optio-smoke' "${log}" || fail "structured log missing command"
  pass "scenario 1 forbidden tool audit log"

  local allow_body third
  allow_body='{"tool":"read_file","context":{"path":"README.md","run_id":"smoke-allowance","max_tool_calls":2,"agent_id":"smoke"}}'
  for _ in 1 2; do
    local allowed
    allowed="$(curl -sf "${base}/v1/tool-gate" -H 'content-type: application/json' -d "${allow_body}")" \
      || { cat "${log}" >&2 || true; fail "scenario 3 allowance request"; }
    echo "${allowed}" | grep -q '"decision":"allow"' || fail "scenario 3 expected allow inside budget"
  done
  third="$(curl -sf "${base}/v1/tool-gate" -H 'content-type: application/json' -d "${allow_body}")" \
    || { cat "${log}" >&2 || true; fail "scenario 3 over-budget request"; }
  echo "${third}" | grep -q '"decision":"deny"' || fail "scenario 3 not denied"
  echo "${third}" | grep -q '"reason":"tool_allowance_exceeded"' || fail "scenario 3 reason"
  audit="$(curl -sf "${base}/v1/audit")" \
    || { cat "${log}" >&2 || true; fail "scenario 3 audit request"; }
  echo "${audit}" | grep -q 'tool_allowance_exceeded' || fail "scenario 3 audit missing allowance deny"
  grep -q 'tool_allowance_exceeded' "${log}" || fail "scenario 3 structured log missing allowance deny"
  pass "scenario 3 tool allowance exceeded"

  local secret selfcfg hung flow isolated
  secret="$(curl -sf "${base}/v1/tool-gate" -H 'content-type: application/json' \
    -d '{"tool":"read_file","context":{"path":".env","agent_id":"smoke"}}')" \
    || { cat "${log}" >&2 || true; fail "scenario 4 request"; }
  echo "${secret}" | grep -q '"decision":"deny"' || fail "scenario 4 not denied"
  echo "${secret}" | grep -q '"reason":"hard_deny_secret"' || fail "scenario 4 reason"
  audit="$(curl -sf "${base}/v1/audit")" || { cat "${log}" >&2 || true; fail "scenario 4 audit"; }
  echo "${audit}" | grep -q 'hard_deny_secret' || fail "scenario 4 audit missing secret deny"
  grep -q 'hard_deny_secret' "${log}" || fail "scenario 4 structured log missing secret deny"
  pass "scenario 4 secret read"

  selfcfg="$(curl -sf "${base}/v1/tool-gate" -H 'content-type: application/json' \
    -d '{"tool":"edit_file","context":{"path":"AGENTS.md","agent_id":"smoke"}}')" \
    || { cat "${log}" >&2 || true; fail "scenario 5 request"; }
  echo "${selfcfg}" | grep -q '"decision":"deny"' || fail "scenario 5 not denied"
  echo "${selfcfg}" | grep -q '"reason":"self_config_mutation"' || fail "scenario 5 reason"
  grep -q 'self_config_mutation' "${log}" || fail "scenario 5 structured log missing"
  pass "scenario 5 self-config mutation"

  hung="$(curl -sf "${base}/v1/tool-invoke" -H 'content-type: application/json' \
    -d '{"tool":"read_file","timeout_ms":40,"mode":"hang","context":{"path":"src/app.ts"}}')" \
    || { cat "${log}" >&2 || true; fail "scenario 6 request"; }
  echo "${hung}" | grep -q '"status":"cancel"' || fail "scenario 6 status"
  echo "${hung}" | grep -q '"reason":"tool_timeout"' || fail "scenario 6 reason"
  grep -q '"event":"tool_timeout"' "${log}" || fail "scenario 6 structured log missing"
  pass "scenario 6 hung tool timeout"

  flow="$(curl -sf "${base}/v1/flow" -H 'content-type: application/json' \
    -d '{"task_id":"t-smoke","title":"stub a change"}')" \
    || { cat "${log}" >&2 || true; fail "scenario 7 request"; }
  node -e 'const s=JSON.parse(process.argv[1]); const want=["intake","worktree","implementation","review","pr"]; if(!s.ok||JSON.stringify(s.stages)!==JSON.stringify(want)||s.pr.ready!==true) process.exit(1)' \
    "${flow}" || fail "scenario 7 stages"
  pass "scenario 7 end-to-end flow"

  isolated="$(curl -sf "${base}/v1/worktree-isolation" -H 'content-type: application/json' -d '{}')" \
    || { cat "${log}" >&2 || true; fail "scenario 8 request"; }
  node -e 'const s=JSON.parse(process.argv[1]); if(!s.isolated||s.agent_a["note.txt"]!=="alpha"||s.agent_b["note.txt"]!=="beta") process.exit(1)' \
    "${isolated}" || fail "scenario 8 isolation"
  pass "scenario 8 worktree isolation"

  cleanup
  trap - EXIT
}

smoke_kit_harness

if command -v docker >/dev/null 2>&1; then
  if docker compose version >/dev/null 2>&1; then
    # An empty env file skips the project .env so local secrets are not interpolated into logs.
    empty_env="$(mktemp)"
    config_log="$(mktemp)"
    if ! docker compose --env-file "$empty_env" config >"$config_log" 2>&1; then
      grep -v -E '^[A-Za-z_][A-Za-z0-9_]*=' "$config_log" | head -n 40 >&2 || true
      rm -f "$empty_env" "$config_log"
      fail "docker compose config"
    fi
    rm -f "$empty_env" "$config_log"
    pass "docker compose config"
    bash "$ROOT/scripts/smoke-compose-mac.sh" --config-only || fail "compose smoke config"
    if [[ "${SMOKE_COMPOSE_UP:-0}" == "1" ]]; then
      docker compose up -d redis postgres
      pass "compose up redis postgres"
    else
      skip "compose up (bash scripts/smoke-compose-mac.sh for redis+postgres+litellm up/down)"
    fi
    if docker compose config | grep -Eq '^  kit-harness:'; then
      fail "kit-harness is profile-gated and must not appear in default compose config"
    fi
    docker compose --profile harness config | grep -Eq '^  kit-harness:' \
      || fail "docker compose --profile harness missing kit-harness"
    pass "compose profile harness defines kit-harness"
    # Profile render only. Does not start containers. Default redis/postgres/litellm
    # stay in this set; profile full adds orchestrator; profile harness adds kit-harness.
    full_env="$(mktemp)"
    full_log="$(mktemp)"
    if ! docker compose --env-file "$full_env" --profile full --profile harness config >"$full_log" 2>&1; then
      grep -v -E '^[A-Za-z_][A-Za-z0-9_]*=' "$full_log" | head -n 40 >&2 || true
      rm -f "$full_env" "$full_log"
      fail "docker compose --profile full --profile harness config"
    fi
    for svc in redis postgres orchestrator litellm kit-harness; do
      if ! grep -Eq "^  ${svc}:" "$full_log"; then
        rm -f "$full_env" "$full_log"
        fail "profile full+harness missing ${svc}"
      fi
    done
    for svc in redis postgres orchestrator litellm kit-harness; do
      if ! awk -v svc="$svc" '
        $0 ~ "^  " svc ":$" { in_svc=1; next }
        in_svc && $0 ~ "^  [a-z0-9-]+:$" { exit }
        in_svc && $0 ~ "healthcheck:" { found=1 }
        END { exit found ? 0 : 1 }
      ' "$full_log"; then
        rm -f "$full_env" "$full_log"
        fail "profile full+harness missing healthcheck for ${svc}"
      fi
    done
    rm -f "$full_env" "$full_log"
    pass "compose profiles full+harness define redis postgres orchestrator litellm kit-harness"
  else
    skip "docker compose plugin not available"
  fi
else
  skip "docker not available on this host"
fi

# Optional Caveman loopback proxy. Default off. Never downloads the BSL binary.
# Probe only when the operator exported CAVEMAN_PROXY_ENABLED=true.
caveman_enabled="$(printf '%s' "${CAVEMAN_PROXY_ENABLED:-false}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
if [[ "$caveman_enabled" != "true" ]]; then
  skip "caveman proxy (CAVEMAN_PROXY_ENABLED is not true)"
elif ! command -v caveman >/dev/null 2>&1; then
  skip "caveman CLI absent — npm i -g @caveman-ai/cli && caveman setup --install (binary not vendored)"
elif ! command -v curl >/dev/null 2>&1; then
  skip "curl absent; cannot probe caveman /health/live"
else
  caveman_url="${CAVEMAN_PROXY_URL:-http://127.0.0.1:8787}"
  caveman_url="${caveman_url%/}"
  if curl -fsS --max-time 3 "${caveman_url}/health/live" >/dev/null 2>&1; then
    pass "caveman proxy /health/live at ${caveman_url}"
  else
    fail "CAVEMAN_PROXY_ENABLED=true but ${caveman_url}/health/live is down. Start: CAVEMAN_MODE=${CAVEMAN_MODE:-compress} CAVE_SSRF_ALLOWLIST=${CAVE_SSRF_ALLOWLIST:-127.0.0.1} caveman start"
  fi
fi

bash "$ROOT/scripts/hello-world-e2e.sh"

pass "all smoke checks finished"
