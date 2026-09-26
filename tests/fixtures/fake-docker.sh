#!/usr/bin/env bash
# Test double for scripts/smoke-compose-mac.sh. Not a Docker CLI.
IFS=$' \t\n'
set -euo pipefail

if [[ -n "${FAKE_DOCKER_LOG:-}" ]]; then
  printf '%s\n' "$*" >>"$FAKE_DOCKER_LOG"
fi

mode="${FAKE_DOCKER_MODE:-ok}"

if [[ "${1:-}" == "info" ]]; then
  exit 0
fi

if [[ "${1:-}" == "compose" && "${2:-}" == "version" ]]; then
  exit 0
fi

joined="$*"

if [[ "$joined" == *" exec "* && "$joined" == *" redis "* ]]; then
  printf '%s\n' PONG
  exit 0
fi

if [[ "$joined" == *" exec "* && "$joined" == *" postgres "* ]]; then
  exit 0
fi

if [[ "$joined" == *" up "* || "$joined" == *" down "* ]]; then
  if [[ "$mode" == "no-lifecycle" ]]; then
    echo "up/down should not run" >&2
    exit 99
  fi
  exit 0
fi

if [[ "$joined" == *"config --services"* ]]; then
  if [[ "$joined" == *"--profile full"* ]]; then
    printf '%s\n' redis postgres litellm orchestrator eve-runner
    exit 0
  fi
  if [[ "$joined" == *"--profile harness"* ]]; then
    printf '%s\n' redis postgres litellm kit-harness
    exit 0
  fi
  if [[ "$joined" == *"--profile laya"* ]]; then
    printf '%s\n' redis postgres litellm laya
    exit 0
  fi
  if [[ "$mode" == "missing-litellm" ]]; then
    printf '%s\n' redis postgres
    exit 0
  fi
  if [[ "$mode" == "orchestrator-default" ]]; then
    printf '%s\n' redis postgres litellm orchestrator
    exit 0
  fi
  printf '%s\n' redis postgres litellm
  exit 0
fi

if [[ "$joined" == *" config"* ]]; then
  printf 'published: "%s"\n' "${OPTIO_NEW_REDIS_HOST_PORT:?}"
  printf 'published: "%s"\n' "${OPTIO_NEW_POSTGRES_HOST_PORT:?}"
  printf 'published: "%s"\n' "${OPTIO_NEW_LITELLM_HOST_PORT:?}"
  exit 0
fi

echo "unexpected docker invocation: $*" >&2
exit 1
