# Hetzner deploy — kit-harness beside LiteLLM and BullMQ

Checkout on the VPS: `/opt/optio-new` (Compose project `optio-new`).

This runbook is for an operator already on that host. Nothing in this repo opens a remote shell to production.

Secrets stay on the sops+age path in [docs/secrets.md](../docs/secrets.md). The boot unit calls `scripts/secrets.sh` and does not use `EnvironmentFile`.

## Boot profiles

`deploy/systemd/optio-new-compose.service` sets:

```text
COMPOSE_PROFILES=harness,orchestrator
```

`deploy/systemd/agent-harness-compose.service` is the same unit under the historical filename. Install one of them, not both.

| Profile         | Services                     | Started on boot |
| --------------- | ---------------------------- | --------------- |
| (none)          | redis, postgres, litellm     | yes             |
| `harness`       | kit-harness                  | yes             |
| `orchestrator`  | orchestrator (BullMQ worker) | yes             |
| `full`          | orchestrator and eve-runner  | no              |
| `edge`          | caddy (80/443)               | no              |
| `laya`          | laya (CPU placeholder)       | no              |
| `caveman`       | caveman-proxy placeholder    | no              |
| `observability` | otel-collector               | no              |

`orchestrator` is also in profile `full`, so `docker compose --profile full` still starts it together with eve-runner. Profile `laya` stays off for that command and for `COMPOSE_PROFILES=harness,orchestrator`.

Laya is a CPU placeholder (`deploy/laya/stub_server.py`) with a Compose healthcheck on `GET /health`. It does not reserve a GPU. The NVIDIA Container Toolkit is not required. Enable, env vars, and the upstream `laya-serve` swap are in [docs/laya.md](../docs/laya.md). Do not commit `LAYA_API_KEY`.

kit-harness is published on `127.0.0.1:3200` (`KIT_HARNESS_PORT`, default 3200). The image is `Dockerfile.kit-harness` and answers `GET /health`. LiteLLM has no profile, so `scripts/smoke-compose-mac.sh` still sees it in the default service set.

## Ports and firewall

Compose binds the data plane to loopback. Docker does not publish these on the public interface:

| Service       | Host bind        |
| ------------- | ---------------- |
| redis         | `127.0.0.1:6379` |
| postgres      | `127.0.0.1:5432` |
| litellm       | `127.0.0.1:4000` |
| orchestrator  | `127.0.0.1:3100` |
| kit-harness   | `127.0.0.1:3200` |
| laya          | `127.0.0.1:8000` |
| caveman-proxy | `127.0.0.1:8787` |

Profile `edge` publishes Caddy on `80` and `443` on all host interfaces. Leave that profile out of `COMPOSE_PROFILES` until the DNS checklist below is done.

Hetzner Cloud Firewall, inbound:

- `22/tcp` from operator addresses only. Keep fail2ban on SSH.
- `80/tcp` and `443/tcp` only after profile `edge` is enabled.
- No inbound rule for `3200`, `4000`, `3100`, `5432`, `6379`, `8000`, or `8787`.

## Install the unit

On the VPS, from `/opt/optio-new`, after [docs/secrets.md](../docs/secrets.md) steps through `check`:

```bash
export COMPOSE_PROFILES=harness,orchestrator
bash scripts/secrets.sh compose up -d --build
curl -fsS http://127.0.0.1:3200/health
curl -fsS http://127.0.0.1:3100/health
sudo cp deploy/systemd/optio-new-compose.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now optio-new-compose.service
```

A shell without `COMPOSE_PROFILES` (and without `--profile`) leaves kit-harness and the orchestrator stopped. Redis, Postgres, and LiteLLM still start. The unit sets the variable for `ExecStart` and `ExecStop`.

`ExecStop` is `docker compose down` without `-v`. Named volumes stay.

## After merge to main

On the VPS:

```bash
cd /opt/optio-new
bash scripts/vps-pull-rebuild.sh
```

The script fast-forwards `main`, reads `COMPOSE_PROFILES` from the unit, and runs:

```bash
bash scripts/secrets.sh compose up -d --build --pull always
```

Boot `up -d` does not rebuild. Images change only when this script (or the same compose command) runs. If the unit file changed, copy it again and `systemctl daemon-reload`. The script prints that reminder. It does not restart the unit: containers are already recreated by Compose.

The script refuses to run when the checkout is not `/opt/optio-new`, unless `OPTIO_NEW_ALLOW_NONSTANDARD_ROOT=1`.

## Rollback

1. On the VPS, record the current commit: `git rev-parse HEAD`.
2. `git fetch origin main` and `git checkout <previous-sha>`.
3. Export the same profiles and rebuild:

   ```bash
   export COMPOSE_PROFILES=harness,orchestrator
   bash scripts/secrets.sh compose up -d --build
   ```

4. Do not run `docker compose down -v`. That deletes the Postgres and Redis volumes.
5. `systemctl stop optio-new-compose.service` runs `down` without `-v`. Volumes remain. Start the unit again after the checkout is the commit you want.
6. If the unit file is the regression, restore `deploy/systemd/optio-new-compose.service` from the previous commit, copy it to `/etc/systemd/system/`, and `systemctl daemon-reload`.
7. Profile `edge` is not in the boot set. Rolling the harness profile back does not stop Caddy.

If `up --build` fails before containers are replaced, the previous containers keep running. If they were replaced and are unhealthy, check out the previous SHA and run the compose command in step 3 again.

## Remaining secrets and DNS

Ciphertext, the age key, and plaintext `.env` stay on the host. See [docs/secrets.md](../docs/secrets.md). Before calling the boot set done:

- [ ] `/opt/optio-new/secrets/age/key.txt` exists (`mode 0600`) and a copy is in the password manager.
- [ ] `bash scripts/secrets.sh check` passes against `secrets/optio-new.env`.
- [ ] `OPTIO_NEW_POSTGRES_PASSWORD` is not `changeme` (a new password also needs `ALTER USER` or a new volume).
- [ ] `LITELLM_MASTER_KEY` is not `sk-change-me`.
- [ ] `OPENAI_API_KEY` and/or `ANTHROPIC_API_KEY` are set if LiteLLM should call those providers.
- [ ] `OPTIO_NEW_GITHUB_TOKEN` and `OPTIO_NEW_GITHUB_WEBHOOK_SECRET` are set when PR and CI signals are required.
- [ ] `OPTIO_NEW_INTAKE_WEBHOOK_SECRET` is set if HTTP intake is exposed later.
- [ ] `CURSOR_API_KEY` is set when the Cursor adapter runs on the box.
- [ ] `OPTIO_NEW_BACKUP_REPO` and `OPTIO_NEW_BACKUP_PASSWORD` are set before the Storage Box timer.
- [ ] `OPTIO_NEW_HARNESS_URL` stays `http://127.0.0.1:3200`. kit-harness has no public name.
- [ ] DNS: no public record for port `3200`, `4000`, `3100`, `5432`, or `6379`.
- [ ] DNS: `OPTIO_NEW_WEBHOOK_HOST` has an A/AAAA to this VPS only when you later enable profile `edge`.
- [ ] Hetzner Cloud Firewall matches the inbound list above.
- [ ] Plaintext `.env` is removed only after `check` and a healthy `compose up` (see the secrets runbook).
