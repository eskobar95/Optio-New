/**
 * CLI: `eve-runner serve | run | health`.
 * stdout is the JSON result for `run`. Logs go to stderr.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { formatAgentDump, redactSecrets } from "../security/redact.js";
import { EveRequestError } from "./contract.js";
import { startEveHttpServer } from "./http.js";
import { runEveStep } from "./run-step.js";

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  keepAlive?: boolean;
}

export async function executeCli(
  argv: string[],
  io?: { env?: NodeJS.ProcessEnv },
): Promise<CliResult> {
  const env = io?.env ?? process.env;
  try {
    const { command, flags } = parseArgs(argv);
    if (command === "serve") {
      const host = flagString(flags, "host") ?? env.EVE_RUNNER_HOST ?? "0.0.0.0";
      const port = Number(flagString(flags, "port") ?? env.EVE_RUNNER_PORT ?? 3210);
      const started = await startEveHttpServer({
        host,
        port,
        env,
        repoRoot: env.OPTIO_NEW_REPO_ROOT || undefined,
      });
      const shutdown = () => {
        void started.close().then(() => process.exit(0));
      };
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);
      return {
        exitCode: 0,
        stdout: `eve-runner listening on http://${host}:${started.port}\n`,
        stderr: "",
        keepAlive: true,
      };
    }
    if (command === "health") {
      const url =
        flagString(flags, "url") ?? `http://127.0.0.1:${env.EVE_RUNNER_PORT ?? 3210}/health`;
      const response = await fetch(url);
      const text = await response.text();
      return {
        exitCode: response.ok ? 0 : 1,
        stdout: text.endsWith("\n") ? text : `${text}\n`,
        stderr: "",
      };
    }
    if (command === "run") {
      const raw = await readRunPayload(flags);
      const result = await runEveStep(raw, { env, repoRoot: env.OPTIO_NEW_REPO_ROOT || undefined });
      const line = JSON.stringify({
        service: "eve-runner",
        event: "agent.run",
        taskId: result.taskId,
        stepId: result.stepId,
        status: result.artifacts.adapter.status,
        graphAdvanced: false,
      });
      return {
        exitCode: result.ok ? 0 : 2,
        stdout: `${formatAgentDump(result)}\n`,
        stderr: `${redactSecrets(line)}\n`,
      };
    }
    return { exitCode: 1, stdout: "", stderr: `${usage()}\n` };
  } catch (error) {
    if (error instanceof EveRequestError) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `${formatAgentDump({ ok: false, graphAdvanced: false, error: { class: error.errorClass, message: error.message } })}\n`,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: `${redactSecrets(message)}\n` };
  }
}

function usage(): string {
  return "Usage: eve-runner <serve|run|health> [--file path] [--json payload] [--port n] [--host addr] [--url url]";
}

async function readRunPayload(flags: Map<string, string>): Promise<unknown> {
  const file = flags.get("file");
  const json = flags.get("json");
  if (file && json)
    throw new EveRequestError(400, "cli_usage", "Pass only one of --file or --json");
  if (file) return JSON.parse(await readFile(path.resolve(file), "utf8"));
  if (json) return JSON.parse(json);
  throw new EveRequestError(400, "cli_usage", "run requires --file or --json");
}

function parseArgs(argv: string[]): { command: string; flags: Map<string, string> } {
  const [command, ...rest] = argv;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token?.startsWith("--")) {
      throw new EveRequestError(400, "cli_usage", `Unexpected argument ${token}`);
    }
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new EveRequestError(400, "cli_usage", `Missing value for --${key}`);
    }
    flags.set(key, next);
    i += 1;
  }
  return { command: command ?? "", flags };
}

function flagString(flags: Map<string, string>, key: string): string | undefined {
  return flags.get(key);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void executeCli(process.argv.slice(2)).then((result) => {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (!result.keepAlive) process.exit(result.exitCode);
  });
}
