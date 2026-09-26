# Cursor implement feedback

Issue [#85](https://github.com/eskobar95/Optio-New/issues/85). The Cursor implement stage gets ACI-style observations before the review gate. The headless Cursor CLI on the Hetzner host is the runtime. The subscription path is `CURSOR_API_KEY` → `https://api2.cursor.sh`. The same process keeps `CURSOR_API_ENDPOINT` on that host.

## Where it applies

`cursorImplementPrompt` appends `CURSOR_IMPLEMENT_ACI_POLICY` when `metadata.step_id` is `implementation` or `invoke_implementation`. Review, record-diff, and Codex runs keep the task prompt only. Production `invoke_implementation` already passes that step id into `createCursorAdapter`.

The policy text tells the CLI to syntax-check edits, keep search and list output short, and treat a silent success as `Command succeeded with no output.`

## Gate

`gateFileEdit({ path, before, after })` checks `after` and returns the contents to keep plus a short observation.

| Result                  | `blocked` | `content`              | Observation                                                                    |
| ----------------------- | --------- | ---------------------- | ------------------------------------------------------------------------------ |
| No diagnostics          | `false`   | `after`                | `Edit accepted for <path>.`                                                    |
| One or more diagnostics | `true`    | `before` (rolled back) | File name, `Change rolled back.`, up to five `L<line>:` lines, then `(N more)` |

The default checker is `checkSyntax`:

- `.js`, `.mjs`, and `.cjs` use `node --check` (ESM for `.js` / `.mjs`). A missing import is not a syntax error.
- `.ts`, `.mts`, and `.cts` use Node's type stripper when the process provides `stripTypeScriptTypes` (the Node 22 orchestrator image). Otherwise they use the `typescript` package when it is installed (Node 20 CI). A parse error blocks the edit.
- Other paths, including Markdown and JSX/TSX, are not parsed as JavaScript, so a JSX edit is not rolled back by a false syntax error. Pass a checker into `gateFileEdit` when those files need a lint.

A thrown checker becomes a blocked edit whose observation includes the error message.

## Search, list, and commands

`summarizeSearch` shows at most 20 hits by default and never more than 50. Each hit is one line, capped at 160 characters. The summary states `Showing N of M` and ends with `(N more omitted)` when the window cuts the result. An empty search is `No matches.`; an empty list is `No entries.`

`formatCommandObservation` returns `Command succeeded with no output.` when the exit code is 0 and stdout is empty. A stderr warning is appended after that sentence. A non-zero exit is `Command failed (exit N).` and does not use the success sentence.

## Tests

`tests/cursor-implement-feedback.test.ts` covers the gate, the summary window, the empty-command sentence, and the prompt appended only on implement steps.
