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

| Script                            | Purpose                          |
| --------------------------------- | -------------------------------- |
| `npm run lint` / `lint:fix`       | ESLint                           |
| `npm run format` / `format:check` | Prettier                         |
| `npm run typecheck`               | `tsc --noEmit`                   |
| `npm test` / `test:watch`         | Vitest                           |
| `npm run smoke`                   | Local/CI smoke (Docker optional) |
| `npm run ci`                      | Full local gate                  |

## Good first issue

Start with the labeled **good first issue** on GitHub (agent request-response loop: `src/agent/loop.ts` + Vitest mock). See README → First issue.

## Do not

- Commit `.env` or real API keys.
- Add Linear product integration.
- Modify sibling repos (`optio`, `kit-collective`) from this project.

## Status page

Refresh bootstrap/CI/issues snapshot:

```bash
bash scripts/update-status.sh
```

See [docs/status.md](docs/status.md).
