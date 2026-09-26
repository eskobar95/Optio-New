# Harness eval

Regression suite for the factory itself. It does not test customer application code. Each fixture is an intake brief plus the stage outcome the factory must produce.

Mock mode (CI, pre-release, nightly) runs three cases with no Cursor binary, no GitHub API, and no secrets:

| Fixture               | Expected outcome                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `happy-path-open-pr`  | Intake enqueues the stage graph. A mocked CLI succeeds. `open_pr` records pull request 41 and the later stages complete. |
| `missing-credentials` | No `CURSOR_API_KEY` and no model endpoint. The planner fails closed with `missing_credentials`. `open_pr` is not called. |
| `budget-cap`          | The coding agent reports token use above `maxTokens`. The step fails with `token_budget` before `open_pr`.               |

`open_pr` in this suite is `openGithubPullRequest` behind an injected `fetch`. The recorded pull request is the body that fetch returned. Nothing is pushed.

The token cap is the budget check already implemented on the coding agent. The production handler forwards `maxTokens` only when a caller sets it. The Compose orchestrator does not set it, so a normal task still has the wall-clock cap (`agentTimeoutMs`, default 15 minutes) and no token cap. The budget fixture sets `maxTokens` so a harness change that drops the check fails this case.

## Run

From a checkout, including the kit-harness host at `/opt/optio-new`:

```bash
npm ci
npm run eval
```

`npm test` and `npm run ci` run the same mock cases. The command writes:

```text
eval-reports/harness-eval.json
eval-reports/harness-eval.txt
```

The text file is one line per case, `PASS` or `FAIL`, with the expected outcome and the outcome the factory produced. The process exits non-zero when any case fails. The directory is gitignored. GitHub Actions uploads it as the `harness-eval` artifact after the test step.

No `CURSOR_API_KEY`, `OPTIO_NEW_GITHUB_TOKEN`, Redis, or Docker is required for mock mode.

## Nightly and pre-release

Run the mock suite on the kit-harness host. It does not start Compose and does not open a pull request.

```bash
cd /opt/optio-new
git pull --ff-only
npm ci
npm run eval
```

A non-zero exit means a fixture disagreed with the factory. Read `eval-reports/harness-eval.txt` before the next deploy. The same command is the pre-release check, after `npm run ci`.

Example cron (mock only, no secrets in the crontab):

```cron
15 3 * * * cd /opt/optio-new && npm run eval >> /var/log/optio-harness-eval.log 2>&1
```

## Live Cursor fixture

`cheap-cursor` is opt-in. It spawns the real Cursor CLI in a temporary worktree and still mocks git push and the GitHub API, so it does not open a pull request.

```bash
# CURSOR_API_KEY stays in the host environment. Do not write it into the repo.
HARNESS_EVAL_LIVE=1 npm run eval
# or
npm run eval:live
```

`HARNESS_EVAL_LIVE_TIMEOUT_MS` bounds each coding-agent call (default 120000). A missing key fails that case with `missing_credentials`. CI does not set `HARNESS_EVAL_LIVE`.
