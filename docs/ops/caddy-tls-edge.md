# Caddy edge for the intake webhook

Public HTTP in front of the orchestrator intake webhook on the kit-harness host (`/opt/optio-new`, Hetzner). The committed [Caddyfile](../../Caddyfile) is the IP catch-all. It contains no hostname, mailbox, or secret.

The host public address is `62.238.125.114`. Clients call `http://62.238.125.114`. No `OPTIO_NEW_WEBHOOK_HOST` domain is required. Let's Encrypt cannot issue a certificate for a bare IP, so this mode is HTTP only. `OPTIO_NEW_ACME_EMAIL` is not required until a real domain exists.

Loopback HTTP stays in place. `POST /intake` and `GET /health` stay on `127.0.0.1:3100`. kit-harness stays on `127.0.0.1:3200` and is not behind Caddy. Leave profile `edge` off on a laptop: it publishes port `80` on every interface.

## IP HTTP mode (current)

Profile `edge` is in the boot unit (`COMPOSE_PROFILES=harness,orchestrator,edge`). The Caddyfile sets `auto_https off` and serves one site on `:80`.

| Public path                        | Upstream                              |
| ---------------------------------- | ------------------------------------- |
| `http://62.238.125.114/webhooks/*` | `orchestrator:3100` (Compose network) |
| `http://62.238.125.114/healthz`    | Caddy itself (`200` `ok`)             |
| anything else, including `/intake` | `404` from Caddy                      |

Port `80` is published on all host interfaces while this profile is running. Port `443` stays mapped for a later TLS swap; Caddy does not listen on it in this mode. Redis, Postgres, LiteLLM, the orchestrator, and kit-harness stay on `127.0.0.1`.

`POST /webhooks/intake` enqueues the same pipeline as `POST /intake` after HMAC verification. Other `/webhooks/*` paths hit the orchestrator and return `404`. This edge does not accept GitHub webhooks.

`GET /healthz` does not need a secret. The webhook route still needs `OPTIO_NEW_INTAKE_WEBHOOK_SECRET`. A blank secret returns `503` and does not enqueue.

## Future domain + TLS mode

When a DNS name exists, replace the `:80` site (and remove `auto_https off`) with a hostname site. Caddy will then use Let's Encrypt. That swap needs both of these, and IP mode does not:

| Variable                          | IP HTTP mode                    | Domain + TLS mode                       |
| --------------------------------- | ------------------------------- | --------------------------------------- |
| `OPTIO_NEW_WEBHOOK_HOST`          | unset (not read)                | Public DNS name that points at this VPS |
| `OPTIO_NEW_ACME_EMAIL`            | unset (not read)                | Mailbox for the Let's Encrypt account   |
| `OPTIO_NEW_INTAKE_WEBHOOK_SECRET` | required for `/webhooks/intake` | same                                    |

Example site block for that later file (do not commit a real host or mailbox):

```
{
	email {$OPTIO_NEW_ACME_EMAIL}
}

{$OPTIO_NEW_WEBHOOK_HOST} {
	handle /healthz {
		respond "ok" 200
	}

	handle /webhooks/* {
		reverse_proxy orchestrator:3100
	}

	handle {
		respond "not found" 404
	}
}
```

`OPTIO_NEW_WEBHOOK_HOST=localhost` makes Caddy use its internal issuer. That is not this VPS. The Compose defaults (`localhost`, `tls-edge@localhost.invalid`) exist so a TLS Caddyfile can start in dev. Let's Encrypt will not issue for that placeholder.

Keep the same routes. Open firewall `443/tcp` when this mode is on. Clients then use `https://<host>/...`.

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
curl -fsS -X POST "http://62.238.125.114/webhooks/intake" \
  -H 'content-type: application/json' \
  -H "X-Optio-Signature: ${SIG}" \
  --data-binary "$BODY"
```

The signed bytes must match the body on the wire. Loopback `POST /intake` does not require this header.

## Enable on the VPS

1. No DNS record. No ACME mailbox. No public name for ports `3200`, `4000`, `3100`, `5432`, or `6379`.
2. Encrypt `OPTIO_NEW_INTAKE_WEBHOOK_SECRET` with sops+age when the webhook should enqueue. `bash scripts/secrets.sh check` must pass. Leave `OPTIO_NEW_WEBHOOK_HOST` and `OPTIO_NEW_ACME_EMAIL` empty in this mode.
3. Hetzner Cloud Firewall: allow `80/tcp`. Keep `22/tcp` limited to operator addresses. `443/tcp` can stay closed until domain + TLS. Do not open the loopback ports.
4. The boot unit already includes profile `edge`. Install that unit so a reboot matches the repo. A host drop-in is optional and replaces `COMPOSE_PROFILES`; if you keep one, the list must still contain `harness`, `orchestrator`, and `edge`.

   ```bash
   sudo cp deploy/systemd/optio-new-compose.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl restart optio-new-compose.service
   ```

   `restart` runs `docker compose down` (no `-v`) and then `up`. With `edge` in `COMPOSE_PROFILES`, `up` starts Caddy.

5. Confirm:

   ```bash
   curl -fsS http://62.238.125.114/healthz
   curl -fsS http://127.0.0.1:3100/health
   curl -fsS http://127.0.0.1:3200/health
   ```

   `http://62.238.125.114/healthz` returns `ok`. `http://62.238.125.114/intake` returns `404`.

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

## Turn the public listener off

Remove `edge` from `COMPOSE_PROFILES` in the installed unit (and from any drop-in), `systemctl daemon-reload`, and `systemctl restart optio-new-compose.service`. The restart stops Caddy. Close firewall `80/tcp` if nothing else needs it. `POST /intake` on `127.0.0.1:3100` is unchanged. Certificate material, if a later TLS mode created it, stays in the `optio_new_caddy_data` volume until you remove that volume yourself.
