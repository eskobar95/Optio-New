# Secret redaction

Orchestrator stage logs, exported OpenTelemetry spans, and stored agent dumps pass through `src/security/redact.ts` before they are written or exported. The replacement text is `[redacted]`.

Covered material:

- Assigned values for Optio secret env names, including `CURSOR_API_KEY`, `OPTIO_NEW_GITHUB_TOKEN`, and `MODEL_API_KEY` (the full list is `SECRET_ENV_NAMES`).
- URL userinfo passwords, `Bearer` and `Basic` credentials, and PEM private keys.
- Common key shapes: `sk-`, `ghp_` / `gho_` / `ghu_` / `ghs_` / `ghr_`, `github_pat_`, `glpat-`, Slack `xox*-`, AWS `AKIA`, Google `AIza`, Cursor `crsr_`.
- High-entropy mixed-case tokens of 32 characters or more. Hex ids stay (UUIDs, trace ids, SHA-256 fingerprints).

Exact token scrubbing in the GitHub client and CodingAgent adapters still runs after this pass, so a low-entropy value that was present in the process env is removed even when it has no prefix.

This note does not change kit-harness deploy manifests, Compose, or systemd.

## Verify on the kit-harness host

Do not paste live credentials into a shell, a ticket, or chat. The check looks for shapes, not for a known secret.

1. On a checkout of this repo, the unit test is the proof that known fixtures never survive formatting:

   ```bash
   npx vitest run tests/secret-redaction.test.ts
   ```

2. On the VPS, from `/opt/optio-new`, scan recent service logs. Use the secrets helper so Compose does not fall back to an unrelated env file:

   ```bash
   bash scripts/secrets.sh compose logs --since 24h --no-color \
     orchestrator kit-harness learning-worker eve-runner \
     | grep -E 'ghp_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9]{8,}|crsr_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}' \
     || true
   ```

   Empty output is the expected result. `[redacted]` in a line is expected and does not match the pattern above.

3. If a line matches, treat the credential as leaked. Rotate it in `secrets/optio-new.env` (`docs/secrets.md`) and restart through `scripts/secrets.sh compose`. Do not copy the matching line into chat.
