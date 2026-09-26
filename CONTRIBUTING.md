# Contributing to Optio-New

Thanks for helping. Optio-New is a **TypeScript** self-hosted coding-agent factory: **New Bot** decides, **BullMQ** runs the pipeline. Linear is out of scope (see `docs/SPEC.md` §8).

## Setup

```bash
git clone https://github.com/eskobar95/Optio-New.git
cd Optio-New
cp .env.example .env   # never commit real secrets
npm install            # installs Husky pre-commit via prepare
npm run ci             # format:check + lint + typecheck + test + smoke
```

Hetzner kit-harness (`/opt/optio-new`) encrypts that `.env` with **sops + age**. Runbook: [docs/secrets.md](docs/secrets.md).

```bash
bash scripts/secrets.sh audit
```

## Branching & PRs

1. Create a branch from `main`: `git checkout -b feat/short-name`
2. Make focused commits (English messages).
3. Pre-commit (Husky + lint-staged) formats/lints staged files and runs `typecheck`.
4. Open a PR into `main`. **CI must be green** before merge:
   - `npm run format:check`
   - `npm run lint`
   - `npm run typecheck`
   - `npm test` (Vitest)
   - `npm run smoke`

## Scripts

| Script                            | Purpose                                                |
| --------------------------------- | ------------------------------------------------------ |
| `npm run lint` / `lint:fix`       | ESLint                                                 |
| `npm run format` / `format:check` | Prettier                                               |
| `npm run typecheck`               | `tsc --noEmit`                                         |
| `npm test` / `test:watch`         | Vitest                                                 |
| `npm run smoke`                   | Local/CI smoke (Docker optional; compose up stays off) |
| `npm run smoke:compose`           | Mac Docker Desktop up/down of redis, postgres, litellm |
| `npm run ci`                      | Full local gate                                        |
| `npm run status`                  | Refresh `docs/status.md`                               |

## Good first issue

Start with the labeled **good first issue** on GitHub (agent request-response loop: `src/agent/loop.ts` + Vitest mock). See README → First issue.

## Do not

- Commit `.env`, age private keys, production ciphertext, or real API keys.
- Add Linear product integration.
- Modify sibling repos (`optio`, `kit-collective`) from this project.

## Status page

`docs/status.md` is the bootstrap snapshot: CI badge, latest CI conclusion, and open issues.

Refresh it manually (requires [GitHub CLI](https://cli.github.com/) and `gh auth login`):

```bash
npm run status
```

`scripts/update-status.sh` is idempotent. It rewrites `docs/status.md` only when the latest CI conclusion or the open-issue list changes, so running it twice leaves the file untouched.

CI does not refresh the page inside `npm run ci`. [`.github/workflows/status.yml`](.github/workflows/status.yml) runs the same script on a daily schedule, on **Actions → Status → Run workflow**, and after the CI workflow completes on `main`. That job commits `docs/status.md` only when the snapshot changed.

See [docs/status.md](docs/status.md).
