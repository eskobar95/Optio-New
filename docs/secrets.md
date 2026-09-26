# Secrets — Hetzner kit-harness

Optio-New on the Hetzner VPS (`/opt/optio-new`) uses **sops + age**.

The checkout already has a local plaintext `.env` with generated Postgres and LiteLLM keys. sops encrypts that file on the host. Compose loads it through `scripts/secrets.sh`. Nothing in this path puts production secrets in git or in CI logs.

Infisical is an optional later swap. It is not what this host runs. Key names stay the same either way, so Compose and the orchestrator do not change.

## Why sops + age

- The host already has `/opt/optio-new/.env`. Encrypting it is a local step. No vault service, login, or network hop at boot.
- The age private key stays on the VPS (`mode 0600`). Git stores templates only.
- Production ciphertext stays on the host too. This is a single-operator kit-harness, not a shared team vault. A lost disk is recovered from the age-key backup plus a host backup, not from the git history.
- systemd must not use `EnvironmentFile` for these values. `systemctl show` would print them. The unit calls the helper, which decrypts to a `0600` file under `/dev/shm` and passes `--env-file`.

## What never goes in git

| Path                                   | Role                                                   |
| -------------------------------------- | ------------------------------------------------------ |
| `/opt/optio-new/.env`                  | Existing plaintext. Gitignored. Remove after `check`.  |
| `/opt/optio-new/secrets/age/key.txt`   | Age private key. Gitignored.                           |
| `/opt/optio-new/secrets/.sops.yaml`    | Host creation rules (public recipient). Gitignored.    |
| `/opt/optio-new/secrets/optio-new.env` | sops ciphertext of the real env. Gitignored.           |
| `.env.example`, `secrets/.env.example` | Placeholders only (`changeme`, `sk-change-me`, empty). |
| `secrets/.sops.yaml.example`           | Placeholder recipient `AGE_RECIPIENT_REPLACE_ME`.      |

Back up `secrets/age/key.txt` to a password manager. The encrypted env is useless without that key, and the key must not live only inside the encrypted env. Host backups (restic/borg to Hetzner Storage Box) may include `secrets/`, but the git remote must not.

## Key names

Templates list every name Compose and the agent loop read:

- `MODEL_API_KEY`, `MODEL_ENDPOINT` — model adapter (`src/agent/env-adapter.ts`)
- `OPTIO_NEW_*` — Postgres, Redis, Jev, intake, GitHub, backups
- `LITELLM_MASTER_KEY`, `LITELLM_BASE_URL`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` — LiteLLM process env
- `OPTIO_NEW_HARNESS_URL` — kit-harness on the host (`http://127.0.0.1:3200`). Not a public name.
- `CURSOR_API_KEY` — Cursor subscription CLI
- `KIT_HARNESS_PORT` — decision sidecar bind port (default 3200, host `127.0.0.1`)
- `CAVEMAN_*` and optional `CAVE_SSRF_ALLOWLIST` — local proxy, default off

`LITELLM_*` and provider keys are unprefixed because the LiteLLM image reads those names. `gateway/litellm/config.yaml.example` references them with `os.environ/...`.

## Install on the VPS

Ubuntu on Hetzner:

```bash
sudo apt-get update
sudo apt-get install -y age
```

sops is not in Ubuntu main. Install the pinned upstream release (v3.13.3) and check the published checksum file before putting the binary on `PATH`:

```bash
SOPS_VERSION=3.13.3
cd /tmp
curl -fsSL -O "https://github.com/getsops/sops/releases/download/v${SOPS_VERSION}/sops-v${SOPS_VERSION}.linux.amd64"
curl -fsSL -O "https://github.com/getsops/sops/releases/download/v${SOPS_VERSION}/sops-v${SOPS_VERSION}.checksums.txt"
sha256sum -c "sops-v${SOPS_VERSION}.checksums.txt" --ignore-missing
sudo install -m 0755 "sops-v${SOPS_VERSION}.linux.amd64" /usr/local/bin/sops
sops --version
age --version
```

A `.deb` is on the same GitHub release (`sops_${SOPS_VERSION}_amd64.deb`) if you prefer the package.

## Operator path

Run from `/opt/optio-new`. The helper prints paths, key counts, and the age public recipient. It does not print secret values.

1. Confirm the existing env is the one you intend to keep, and that git does not track it:

   ```bash
   git check-ignore -v .env
   bash scripts/secrets.sh audit
   ```

2. Create the host age key and `secrets/.sops.yaml`:

   ```bash
   bash scripts/secrets.sh init
   ```

   This writes `secrets/age/key.txt` (`mode 0600`) and a public recipient. It does not overwrite an existing key. Copy the private key into the password manager before continuing.

3. Encrypt the existing `.env` (Postgres and LiteLLM keys included):

   ```bash
   bash scripts/secrets.sh encrypt
   ```

   Output is `secrets/optio-new.env` (`mode 0600`). The plaintext `.env` is left in place until the check passes.

4. Prove decrypt matches the plaintext. The command compares hashes and does not print values:

   ```bash
   bash scripts/secrets.sh check
   ```

5. Start Compose through the helper. Once ciphertext exists, the helper prefers it and ignores the plaintext file. Export the boot profiles or kit-harness and the orchestrator stay stopped (LiteLLM still starts):

   ```bash
   export COMPOSE_PROFILES=harness,orchestrator
   bash scripts/secrets.sh compose up -d
   ```

   The systemd unit sets `COMPOSE_PROFILES` itself. See [deploy/README.md](../deploy/README.md).

6. Remove the plaintext only after the stack is healthy:

   ```bash
   shred -u .env 2>/dev/null || rm -f .env
   ```

   After that, start the stack only with `scripts/secrets.sh compose` or the systemd unit. A bare `docker compose up` interpolates the `changeme` defaults from `docker-compose.yml` and will not match the Postgres password already stored in the volume.

7. Enable boot:

   ```bash
   sudo cp deploy/systemd/optio-new-compose.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now optio-new-compose.service
   ```

`deploy/systemd/agent-harness-compose.service` is the same unit under the historical filename. Install one of them.

### Rotation

1. Edit a throwaway plaintext copy outside the repo, or decrypt to a `0600` file under `/dev/shm` yourself.
2. `bash scripts/secrets.sh encrypt --force /dev/shm/optio-new.env secrets/optio-new.env`
3. `bash scripts/secrets.sh check` against that plaintext, then shred the plaintext.
4. `COMPOSE_PROFILES=harness,orchestrator bash scripts/secrets.sh compose up -d` so containers pick up the new interpolation.
5. To replace the age key: `init` will refuse to overwrite `key.txt`. Generate a new key beside it, `init --force` after pointing `SOPS_AGE_KEY_FILE` at the new key, re-encrypt with `--force`, confirm `check`, then shred the old key.

Postgres password changes also require `ALTER USER` (or a new volume). Encrypting a new password does not rewrite the data directory.

## Decrypt / load path for Compose

`docker-compose.yml` interpolates `${OPTIO_NEW_POSTGRES_PASSWORD}`, `${LITELLM_MASTER_KEY}`, and the other keys at start time. It does not set `env_file:`. The helper is the loader:

1. If `secrets/optio-new.env` exists, decrypt with `SOPS_AGE_KEY_FILE` to a `mktemp` file on `/dev/shm` (`mode 0600`).
2. `docker compose --env-file <that file> -f docker-compose.yml "$@"`.
3. Delete the temp file when the command exits.
4. If ciphertext is not there yet, fall back to `.env`, then `secrets/.env`, and say so on stderr without values. That keeps the current host working before step 3 above.

`--env-file` replaces Compose's default `.env` lookup. The unit sets `WorkingDirectory=/opt/optio-new`, `SOPS_AGE_KEY_FILE=/opt/optio-new/secrets/age/key.txt`, and `COMPOSE_PROFILES=harness,orchestrator`. LiteLLM stays in the default service set. The profile list is not a secret. `EnvironmentFile` stays unset.

## Postgres backups

The daily dump does not use systemd `EnvironmentFile`. That would print values through `systemctl show`. The timer runs:

```bash
scripts/secrets.sh run scripts/backup-postgres-to-storagebox.sh
```

`run` decrypts `secrets/optio-new.env` to a `0600` tmpfs file, exports the assignments, runs the command, and deletes the file. `OPTIO_NEW_DATABASE_URL` and `OPTIO_NEW_BACKUP_*` live in that same encrypted env. The Storage Box SSH private key is `secrets/storagebox_ed25519` (`mode 0600`, gitignored), not a value inside the env file.

Runbook: [docs/ops/postgres-storagebox-backup.md](ops/postgres-storagebox-backup.md).

Infisical is still not installed on this host. A later swap keeps these key names and points the timer at `infisical run` instead of `secrets.sh run`. Do not commit the token.

## CI

GitHub Actions does not receive production env files and does not enable step debug. `bash scripts/secrets.sh audit` runs from `scripts/smoke-local.sh` and from Vitest. It checks gitignore rules and tracked paths, and it searches tracked files for private-key markers. Matches print the path only.

`docker compose config` in smoke passes an empty `--env-file`, so a local `.env` is not interpolated. Success output is discarded. A failure prints the log with assignment lines removed.

`scripts/secrets.sh roundtrip` encrypts a placeholder file with a throwaway key when `sops` and `age-keygen` are installed. It skips when they are absent, so CI does not download them. Set `SECRETS_ROUNDTRIP_REQUIRED=1` on a host where the tools should be present.

## Infisical (not the kit-harness default)

Use Infisical only if you later want a shared UI or more than one operator. Keep the same key names as `.env.example`. Inject with the Infisical CLI into a gitignored env file and pass that file to `docker compose --env-file`. Do not commit the export. Do not point Compose at a different variable scheme.

Until that exists, do not run an Infisical agent on this VPS.
