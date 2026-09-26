#!/usr/bin/env bash
# Host-runnable proof for the PR safety gate (issue #81).
# Runs the unit tests that cover fail-closed checks, secret and destructive
# diffs, and the production open/merge block. Does not push or merge.
set -eu
cd "$(dirname "$0")/.."
npx vitest run tests/pr-safety-gate.test.ts tests/production-stage-handler.test.ts
echo "[pr-safety] PASS"
