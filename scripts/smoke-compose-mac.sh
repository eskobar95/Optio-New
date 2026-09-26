#!/usr/bin/env bash
# Compose smoke for the default data plane (issue #23).
# Host-agnostic: Mac Docker Desktop or Linux Docker (Compose v2).
#
# Checks `docker compose config`, then up/down of redis, postgres, and litellm.
# orchestrator and eve-runner stay on profile "full" and are not started.
#
# Isolated project: optio-new-mac-smoke
# Host ports: 16379 (redis), 15432 (postgres), 14000 (litellm)
# so a running `optio-new` stack on 6379/5432/4000 is left alone.
#
# Env: repo-root `.env` when it exists, otherwise `.env.example`.
# The script does not write `.env` and does not print rendered config (secrets).
#
# Requires the Docker Compose v2 CLI (`docker compose`). Up/down also needs
# a running Docker daemon and `curl`. `--config-only` does not start the daemon.
# CI syntax-checks this file and runs `--config-only` when the CLI is present.
# `command` skips a shell function named docker or curl so the PATH entry wins.
IFS=$' \t\n'
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PROJECT="${OPTIO_NEW_SMOKE_PROJECT:-optio-new-mac-smoke}"
REDIS_PORT="${OPTIO_NEW_SMOKE_REDIS_PORT:-16379}"
POSTGRES_PORT="${OPTIO_NEW_SMOKE_POSTGRES_PORT:-15432}"
LITELLM_PORT="${OPTIO_NEW_SMOKE_LITELLM_PORT:-14000}"
WAIT_SECS="${OPTIO_NEW_SMOKE_WAIT_SECS:-180}"
CONFIG_ONLY=0
KEEP=0
started=0
CONFIG_OUT=""

usage() {
  cat <<'EOF'
Usage: scripts/smoke-compose-mac.sh [--config-only] [--keep]

  --config-only   Validate compose config and the default, full, harness, and
                  laya service sets. Do not pull images or start containers.
  --keep          Leave the smoke stack up after health checks.

Env (optional):
  OPTIO_NEW_SMOKE_PROJECT       default optio-new-mac-smoke
  OPTIO_NEW_SMOKE_REDIS_PORT    default 16379
  OPTIO_NEW_SMOKE_POSTGRES_PORT default 15432
  OPTIO_NEW_SMOKE_LITELLM_PORT  default 14000
  OPTIO_NEW_SMOKE_WAIT_SECS     default 180

Secrets stay in .env (gitignored) or in the .env.example placeholders.
EOF
}

pass() { echo "[smoke-compose] PASS: $*"; }
fail() { echo "[smoke-compose] FAIL: $*" >&2; exit 1; }
info() { echo "[smoke-compose] $*"; }

has_service() {
  local name="$1"
  local list="$2"
  local line
  # A pipe into `grep -q` can return 141 under pipefail when grep exits early,
  # which the caller treats as "service missing" and aborts before up/down.
  while IFS= read -r line; do
    [[ "$line" == "$name" ]] && return 0
  done <<<"$list"
  return 1
}

env_get() {
  local key="$1"
  local default="$2"
  local file="$3"
  local line val
  line="$(grep -E "^${key}=" "$file" | tail -n 1 || true)"
  if [[ -z "$line" ]]; then
    printf '%s' "$default"
    return
  fi
  val="${line#*=}"
  val="${val%$'\r'}"
  printf '%s' "$val"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config-only) CONFIG_ONLY=1 ;;
    --keep) KEEP=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) fail "unknown argument: $1 (try --help)" ;;
  esac
  shift
done

if [[ -f .env ]]; then
  ENV_FILE=".env"
  info "using .env (gitignored; values are not printed)"
elif [[ -f .env.example ]]; then
  ENV_FILE=".env.example"
  info "using .env.example placeholders (no repo-root .env)"
else
  fail "missing .env.example"
fi

export OPTIO_NEW_REDIS_HOST_PORT="$REDIS_PORT"
export OPTIO_NEW_POSTGRES_HOST_PORT="$POSTGRES_PORT"
export OPTIO_NEW_LITELLM_HOST_PORT="$LITELLM_PORT"

PG_USER="${OPTIO_NEW_POSTGRES_USER:-}"
if [[ -z "$PG_USER" ]]; then
  PG_USER="$(env_get OPTIO_NEW_POSTGRES_USER optio "$ENV_FILE")"
fi
PG_DB="${OPTIO_NEW_POSTGRES_DB:-}"
if [[ -z "$PG_DB" ]]; then
  PG_DB="$(env_get OPTIO_NEW_POSTGRES_DB optio_new "$ENV_FILE")"
fi

compose() {
  command docker compose --env-file "$ENV_FILE" -p "$PROJECT" "$@"
}

cleanup() {
  local status=$?
  # Drop the trap and errexit so a cleanup failure cannot replace status 0.
  trap - EXIT
  set +e
  set +u
  if [[ "${started:-0}" == "1" && "${KEEP:-0}" != "1" ]]; then
    command docker compose --env-file "${ENV_FILE:-.env.example}" -p "${PROJECT:-optio-new-mac-smoke}" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  if [[ -n "${CONFIG_OUT:-}" ]]; then
    rm -f "$CONFIG_OUT" || true
  fi
  exit "$status"
}
trap cleanup EXIT

type -P docker >/dev/null 2>&1 || fail "docker not found. Install Docker Engine or Docker Desktop and start the daemon."
command docker compose version >/dev/null 2>&1 || fail "docker compose plugin not available. Install Compose v2 (the docker compose command)."

CONFIG_OUT="$(mktemp "${TMPDIR:-/tmp}/optio-new-compose-smoke.XXXXXX")"
chmod 600 "$CONFIG_OUT"
compose config >"$CONFIG_OUT"
pass "compose config"

assert_published() {
  local port="$1"
  local label="$2"
  if grep -E -q "published: \"?${port}\"?([^0-9]|\$)" "$CONFIG_OUT"; then
    return 0
  fi
  if grep -q "127.0.0.1:${port}:" "$CONFIG_OUT"; then
    return 0
  fi
  fail "${label} host port ${port} missing from rendered compose config"
}

assert_published "$REDIS_PORT" redis
assert_published "$POSTGRES_PORT" postgres
assert_published "$LITELLM_PORT" litellm
pass "smoke host ports ${REDIS_PORT}/${POSTGRES_PORT}/${LITELLM_PORT}"

services="$(compose config --services)"
for name in redis postgres litellm; do
  has_service "$name" "$services" || fail "default compose services missing ${name}"
done
pass "default services include redis postgres litellm"

for name in orchestrator eve-runner; do
  if has_service "$name" "$services"; then
    fail "${name} is in the default service set; keep it on profile full"
  fi
done
pass "orchestrator and eve-runner are not in the default service set"

for name in kit-harness laya; do
  if has_service "$name" "$services"; then
    fail "${name} is in the default service set; it is off unless its profile is selected"
  fi
done
pass "kit-harness and laya are not in the default service set"

full_services="$(compose --profile full config --services)"
for name in orchestrator eve-runner redis postgres litellm; do
  has_service "$name" "$full_services" || fail "profile full missing ${name}"
done
if has_service laya "$full_services"; then
  fail "profile full must not start laya"
fi
pass "profile full includes orchestrator and eve-runner"

harness_services="$(compose --profile harness config --services)"
has_service kit-harness "$harness_services" || fail "profile harness missing kit-harness"
if has_service laya "$harness_services"; then
  fail "profile harness must not start laya"
fi
pass "profile harness includes kit-harness"

laya_services="$(compose --profile laya config --services)"
has_service laya "$laya_services" || fail "profile laya missing laya"
for name in orchestrator eve-runner kit-harness; do
  if has_service "$name" "$laya_services"; then
    fail "profile laya must not start ${name}"
  fi
done
pass "profile laya includes laya and leaves harness and full stopped"

rm -f "$CONFIG_OUT"
CONFIG_OUT=""

if [[ "$CONFIG_ONLY" == "1" ]]; then
  pass "config-only; skipped up/down"
  exit 0
fi

command docker info >/dev/null 2>&1 || fail "Docker daemon is not reachable. Start Docker Engine or Docker Desktop and wait until the daemon is running."
type -P curl >/dev/null 2>&1 || fail "curl not found (needed for the LiteLLM liveliness check)"

info "compose up redis postgres litellm (project ${PROJECT})"
started=1
compose up -d redis postgres litellm

redis_ok=0
pg_ok=0
llm_ok=0
deadline=$((SECONDS + WAIT_SECS))
while [[ "$SECONDS" -lt "$deadline" ]]; do
  if [[ "$redis_ok" != "1" ]]; then
    # Capture ping output. A pipe into `grep -q` can raise SIGPIPE under
    # `pipefail` and abort the script before the health wait finishes.
    redis_out="$(compose exec -T redis redis-cli ping 2>/dev/null || true)"
    if [[ "$redis_out" == *PONG* ]]; then
      redis_ok=1
      pass "redis ping"
    fi
  fi
  if [[ "$pg_ok" != "1" ]]; then
    if compose exec -T postgres pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; then
      pg_ok=1
      pass "postgres pg_isready"
    fi
  fi
  if [[ "$llm_ok" != "1" ]]; then
    code="$(command curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${LITELLM_PORT}/health/liveliness" || true)"
    if [[ "$code" != "200" ]]; then
      code="$(command curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${LITELLM_PORT}/health/liveness" || true)"
    fi
    if [[ "$code" == "200" ]]; then
      llm_ok=1
      pass "litellm /health/liveliness"
    fi
  fi
  if [[ "$redis_ok" == "1" && "$pg_ok" == "1" && "$llm_ok" == "1" ]]; then
    break
  fi
  sleep 2
done

[[ "$redis_ok" == "1" ]] || fail "redis did not respond to PING within ${WAIT_SECS}s"
[[ "$pg_ok" == "1" ]] || fail "postgres was not ready within ${WAIT_SECS}s"
[[ "$llm_ok" == "1" ]] || fail "litellm /health/liveliness did not return 200 within ${WAIT_SECS}s (image ghcr.io/berriai/litellm:main-latest). File a GitHub issue with the [smoke-compose] lines; do not commit .env."

if [[ "$KEEP" == "1" ]]; then
  started=0
  info "keeping stack (project ${PROJECT}). Stop with: docker compose --env-file ${ENV_FILE} -p ${PROJECT} down -v"
else
  compose down -v --remove-orphans
  started=0
  pass "compose down"
fi

pass "compose smoke finished"
