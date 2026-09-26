#!/usr/bin/env bash
# Host chaos proof: SIGKILL during implement, then resume from the step cursor.
# Does not start Compose, does not call GitHub, and does not print secrets.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
npx vitest run tests/chaos-resume.test.ts
