#!/usr/bin/env bash
# Test double for the LiteLLM liveliness probe. Not a network client.
# Honors -o and -w so `%{http_code}` is the status even when the body is discarded.
set -eu
IFS=$' \t\n'

output=""
write_format=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o)
      [[ $# -ge 2 ]] || exit 2
      output="$2"
      shift 2
      ;;
    -w)
      [[ $# -ge 2 ]] || exit 2
      write_format="$2"
      shift 2
      ;;
    --max-time)
      [[ $# -ge 2 ]] || exit 2
      shift 2
      ;;
    --max-time=*)
      shift
      ;;
    -*)
      shift
      ;;
    *)
      shift
      ;;
  esac
done

body="200"
if [[ -n "$output" && "$output" != "/dev/null" ]]; then
  printf '%s' "$body" >"$output"
fi
if [[ -n "$write_format" ]]; then
  printf '%s' "${write_format//\%\{http_code\}/200}"
elif [[ -z "$output" ]]; then
  printf '%s' "$body"
fi
exit 0
