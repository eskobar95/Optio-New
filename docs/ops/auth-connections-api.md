# Optio catalog API — auth & connections (ENG-23)

Minimal HTTP API for tenants, workspaces, memberships, and vaulted connection configs.
Glass / OpenWebUI UI is **out of scope** here (wires later in KitCollective/workplace).

## Auth choice (locked)

- **Email/password** (ENG-22 / ENG-24 Decisions). Magic link is not in this snit.
- Passwords are hashed with Node `crypto.scrypt` (`scrypt$n$r$p$salt$hash`). No plaintext passwords in responses or logs.
- Sessions are HMAC-signed bearer tokens (`OPTIO_NEW_API_SESSION_SECRET`, min 16 chars). No session table in the ENG-24 schema.

## Routes

| Method                 | Path                                        | Notes                                                              |
| ---------------------- | ------------------------------------------- | ------------------------------------------------------------------ |
| `GET`                  | `/health`                                   | `{ ok, service: "optio-api", db }`                                 |
| `POST`                 | `/auth/register`                            | Creates tenant + user; optional first workspace (owner membership) |
| `POST`                 | `/auth/login`                               | `{ email, password, tenantSlug }`                                  |
| `GET`                  | `/auth/me`                                  | Bearer required                                                    |
| `GET`                  | `/memberships`                              | List workspace memberships                                         |
| `POST`                 | `/memberships/switch`                       | `{ workspaceId }` → new token with active workspace                |
| `POST`                 | `/workspaces`                               | Create workspace under the session tenant                          |
| `GET`/`POST`           | `/workspaces/:id/connections`               | List / create (`github` \| `linear` \| `slack` \| `mcp`)           |
| `GET`/`PATCH`/`DELETE` | `/workspaces/:id/connections/:connectionId` | CRUD one connection                                                |
| `GET`                  | `/workspaces/:id/agents`                    | Read-only catalog from Drizzle                                     |
| `GET`                  | `/workspaces/:id/skills`                    | Read-only catalog from Drizzle                                     |

Connection bodies accept only:

- `kind`, `name`, `infisicalSecretPath`
- non-secret `config` (urls, scopes, owner/repo, team keys, …)
- `enabled`

Any plaintext secret field (`token`, `apiKey`, `password`, …) → `400 plaintext_secret_rejected`.
Credentials live in **Infisical per workspace** (path ref in DB only).

## Run

Standalone:

```bash
OPTIO_NEW_DATABASE_URL=postgres://… \
OPTIO_NEW_API_SESSION_SECRET=replace-me-min-16 \
OPTIO_NEW_API_PORT=3210 \
npm run optio-api
```

Or with the orchestrator process when `OPTIO_NEW_API_ENABLED=1` (same env vars; listens on `OPTIO_NEW_API_HOST` / `OPTIO_NEW_API_PORT`, default `127.0.0.1:3210`).

Migrations must already be applied (`npm run db:migrate` / orchestrator boot runs `runDrizzleMigrations`).

## Tests

Unit tests use `MemoryOptioApiStore` (no Postgres):

```bash
npx vitest run tests/optio-api.test.ts
```

## Non-goals

- Glass / OpenWebUI screens
- Agent / skill / workflow builders
- Storing connector secrets in Postgres
- Magic-link auth
