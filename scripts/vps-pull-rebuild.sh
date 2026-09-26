#!/usr/bin/env bash
# Pull origin/main and rebuild the Compose stack on the VPS checkout.
# Run it on the host at /opt/optio-new. It takes no host argument and does not
# connect to another machine.
set -euo pipefail

if [[ $# -ne 0 ]]; then
  echo "usage: scripts/vps-pull-rebuild.sh" >&2
  echo "Run this on the kit-harness checkout. It takes no host argument." >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

expected="${OPTIO_NEW_DEPLOY_ROOT:-/opt/optio-new}"
if [[ "$ROOT" != "$expected" && "${OPTIO_NEW_ALLOW_NONSTANDARD_ROOT:-}" != "1" ]]; then
  echo "refusing: checkout is ${ROOT}; expected ${expected}." >&2
  echo "Run this on the VPS. It does not connect to another machine." >&2
  exit 1
fi

read_profiles() {
  sed -n 's/^Environment=COMPOSE_PROFILES=//p' "$1" | head -n 1
}

unit="$ROOT/deploy/systemd/optio-new-compose.service"
profiles="$(read_profiles "$unit")"
if [[ -z "$profiles" ]]; then
  echo "missing Environment=COMPOSE_PROFILES in ${unit}" >&2
  exit 1
fi

git fetch origin main
git checkout main
git pull --ff-only origin main

profiles="$(read_profiles "$unit")"
if [[ -z "$profiles" ]]; then
  echo "missing Environment=COMPOSE_PROFILES after pull" >&2
  exit 1
fi
export COMPOSE_PROFILES="$profiles"

bash "$ROOT/scripts/secrets.sh" compose up -d --build --pull always

echo "rebuilt COMPOSE_PROFILES=${COMPOSE_PROFILES}"
echo "If the unit file changed, install it on this host:"
echo "  sudo cp deploy/systemd/optio-new-compose.service /etc/systemd/system/"
echo "  sudo systemctl daemon-reload"
