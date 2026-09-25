#!/usr/bin/env bash
# Human-in-the-loop reproduction loop.
# Copy this file, edit the steps below, and run it.
# The agent runs the script; the user follows prompts in their terminal.
#
# Usage:
#   bash scripts/hitl-loop.template.sh
#
# Two helpers:
#   step "instruction" → show instruction, wait for Enter
#   capture VAR "question" → show question, read response into VAR
#
# At the end, captured values are printed as KEY=VALUE for the agent to parse.
# `capture` prints its value back to the terminal — capture observations,
# and leave signing in to the user as a `step`. Never capture secrets.

set -euo pipefail

step() {
  printf '\n>>> %s\n' "$1"
  read -r -p " [Enter when done] " _
}

capture() {
  local var="$1" question="$2" answer
  printf '\n>>> %s\n' "$question"
  read -r -p " > " answer
  printf -v "$var" '%s' "$answer"
}

# --- edit below ---------------------------------------------------------

step "Open the app and sign in (do not paste tokens here)."

capture ERRORED "Did the bug appear? (y/n)"

capture ERROR_MSG "Paste the error message with secrets redacted (or 'none'):"

# --- edit above ---------------------------------------------------------

printf '\n--- Captured ---\n'
printf 'ERRORED=%s\n' "${ERRORED:-}"
printf 'ERROR_MSG=%s\n' "${ERROR_MSG:-}"
