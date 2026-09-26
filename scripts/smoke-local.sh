#!/usr/bin/env bash
# Optio-New local/CI smoke — fast checks; Docker optional.
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

if [[ ! -d node_modules ]]; then
  npm install
else
  pass "node_modules present"
fi

npm run typecheck || fail "typecheck"
pass "typecheck"

npm test || fail "vitest"
pass "vitest"

npx vitest run tests/security-gates.test.ts || fail "security gates"
pass "security gates (secrets deny, config lock, tool timeout)"

if command -v docker >/dev/null 2>&1; then
  if docker compose version >/dev/null 2>&1; then
    docker compose config >/dev/null || fail "docker compose config"
    pass "docker compose config"
    if [[ "${SMOKE_COMPOSE_UP:-0}" == "1" ]]; then
      docker compose up -d redis postgres
      pass "compose up redis postgres"
    else
      skip "compose up (set SMOKE_COMPOSE_UP=1 to enable)"
    fi
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

pass "all smoke checks finished"
