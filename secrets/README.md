# secrets

## sops + age (default)

1. Copy `.sops.yaml.example` → `.sops.yaml` and set age recipients.
2. Copy `.env.example` → `.env`, fill values, encrypt with `sops -e -i .env`.
3. Never commit plaintext `.env`.

## Infisical alternative

If the team prefers Infisical over sops:

1. Create an Infisical project for **Optio-New**.
2. Mirror keys from `.env.example` (prefix `OPTIO_NEW_`).
3. Inject at runtime via Infisical CLI / agent / Compose `env_file` from a decrypted local export that stays gitignored.
4. Keep the same key names so Compose and orchestrator code stay unchanged.

Do not put provider keys in worktrees or issue branches (SPEC §14.5).
