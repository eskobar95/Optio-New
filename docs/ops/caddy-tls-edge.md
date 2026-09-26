# Caddy TLS edge for the intake webhook

Optional public HTTPS in front of the orchestrator intake webhook on the kit-harness host (`/opt/optio-new`, Hetzner). The committed [Caddyfile](../../Caddyfile) is the example. It contains no hostname, mailbox, or secret.

Default stays loopback HTTP. `POST /intake` and `GET /health` stay on `127.0.0.1:3100`. Profile `edge` is not in the boot unit. kit-harness stays on `127.0.0.1:3200` and is not behind Caddy.

## What profile `edge` publishes

| Public path                        | Upstream                              |
| ---------------------------------- | ------------------------------------- |
| `https://<host>/webhooks/*`        | `orchestrator:3100` (Compose network) |
| `https://<host>/healthz`           | Caddy itself (`200`)                  |
| anything else, including `/intake` | `404` from Caddy                      |

Ports `80` and `443` are published on all host interfaces only while this profile is running. Redis, Postgres, LiteLLM, the orchestrator, and kit-harness stay on `127.0.0.1`.

`POST /webhooks/intake` enqueues the same pipeline as `POST /intake` after HMAC verification. Other `/webhooks/*` paths hit the orchestrator and return `404`. This edge does not accept GitHub webhooks.

## Environment

Set these in the host secret store ([docs/secrets.md](../secrets.md)). Do not commit real values.

| Variable                          | Local/dev                         | When profile `edge` is on               |
| --------------------------------- | --------------------------------- | --------------------------------------- |
| `OPTIO_NEW_WEBHOOK_HOST`          | `localhost`                       | Public DNS name that points at this VPS |
| `OPTIO_NEW_ACME_EMAIL`            | empty                             | Mailbox for the Let's Encrypt account   |
| `OPTIO_NEW_INTAKE_WEBHOOK_SECRET` | empty (webhook route returns 503) | Shared HMAC secret                      |

`OPTIO_NEW_WEBHOOK_HOST=localhost` makes Caddy use its internal issuer. That is not the Hetzner setup. Leave profile `edge` off on a laptop.

The placeholder `tls-edge@localhost.invalid` is only the Compose/Caddyfile default when `OPTIO_NEW_ACME_EMAIL` is empty. Let's Encrypt will not issue for it. Set a real mailbox before enabling the profile.

## Auth

Header: `X-Optio-Signature: sha256=<lowercase hex hmac-sha256 of the raw body>`.

The key is `OPTIO_NEW_INTAKE_WEBHOOK_SECRET`. A missing secret, a missing header, or a mismatch does not enqueue. Blank secret → `503` `webhook_auth_unconfigured`. Bad signature → `401` `invalid_signature`.

```bash
BODY='{"brief":{"title":"hello"},"metadata":{"taskId":"t-1"}}'
SIG="$(
  BODY="$BODY" node --input-type=module -e '
    import { createHmac } from "node:crypto";
    const body = process.env.BODY ?? "";
    const secret = process.env.OPTIO_NEW_INTAKE_WEBHOOK_SECRET ?? "";
    process.stdout.write("sha256=" + createHmac("sha256", secret).update(body).digest("hex"));
  '
)"
curl -fsS -X POST "https://${OPTIO_NEW_WEBHOOK_HOST}/webhooks/intake" \
  -H 'content-type: application/json' \
  -H "X-Optio-Signature: ${SIG}" \
  --data-binary "$BODY"
```

The signed bytes must match the body on the wire. Loopback `POST /intake` does not require this header.

## Enable on the VPS

1. DNS: an A/AAAA record for `OPTIO_NEW_WEBHOOK_HOST` to this VPS. No public name for ports `3200`, `4000`, `3100`, `5432`, or `6379`.
2. Encrypt `OPTIO_NEW_WEBHOOK_HOST`, `OPTIO_NEW_ACME_EMAIL`, and `OPTIO_NEW_INTAKE_WEBHOOK_SECRET` with sops+age. `bash scripts/secrets.sh check` must pass.
3. Hetzner Cloud Firewall: allow `80/tcp` and `443/tcp`. Keep `22/tcp` limited to operator addresses. Do not open the loopback ports.
4. Install the drop-in so boot and `scripts/vps-pull-rebuild.sh` both include the profile. The drop-in replaces `COMPOSE_PROFILES`; keep `harness` and `orchestrator` in the list.

   ```bash
   sudo mkdir -p /etc/systemd/system/optio-new-compose.service.d
   sudo cp deploy/systemd/optio-new-edge.conf.example \
     /etc/systemd/system/optio-new-compose.service.d/edge.conf
   sudo systemctl daemon-reload
   sudo systemctl restart optio-new-compose.service
   ```

   `restart` runs `docker compose down` (no `-v`) and then `up`. With the drop-in, `up` starts Caddy. Without the drop-in, that restart stops Caddy.

5. Confirm:

   ```bash
   curl -fsS "https://${OPTIO_NEW_WEBHOOK_HOST}/healthz"
   curl -fsS http://127.0.0.1:3100/health
   curl -fsS http://127.0.0.1:3200/health
   ```

A one-shot start that does not survive the next unit restart:

```bash
export COMPOSE_PROFILES=harness,orchestrator,edge
bash scripts/secrets.sh compose up -d
```

`scripts/vps-pull-rebuild.sh` reads `COMPOSE_PROFILES` from the repo unit, then uses the drop-in when `/etc/systemd/system/optio-new-compose.service.d/edge.conf` exists. The Caddyfile is a bind mount, so a pull updates the file; recreate Caddy when that file changes:

```bash
export COMPOSE_PROFILES=harness,orchestrator,edge
bash scripts/secrets.sh compose up -d --force-recreate caddy
```

## Turn it off

Remove the drop-in, `systemctl daemon-reload`, and `systemctl restart optio-new-compose.service`. The restart stops Caddy. Close firewall `80/tcp` and `443/tcp` if nothing else needs them. `POST /intake` on `127.0.0.1:3100` is unchanged. Certificate material stays in the `optio_new_caddy_data` volume until you remove that volume yourself.
