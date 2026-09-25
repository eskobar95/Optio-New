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

pass "all smoke checks finished"
