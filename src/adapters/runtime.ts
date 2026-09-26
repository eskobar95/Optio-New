/**
 * Process boundary for CodingAgent CLIs.
 * Adapters report a run; they do not advance the workflow or own the worktree.
 */

import { spawn } from "node:child_process";
import { redactSecrets } from "../security/redact.js";

import {
  CANONICAL_SPAN,
  getStageTracer,
  type ActiveSpan,
  type StageTracer,
} from "../orchestrator/telemetry/index.js";
import type {
  CodingAgentInput,
  CodingAgentOutput,
  CodingAgentStatus,
  CodingAgentUsage,
} from "./coding-agent.js";

export interface CliRunRequest {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface CliRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  signal: NodeJS.Signals | null;
}

export type CliRunner = (request: CliRunRequest) => Promise<CliRunResult>;

export interface CodingAgentDeps {
  runner?: CliRunner;
  env?: NodeJS.ProcessEnv;
  /** Writes the Codex runner profile. Defaults to the filesystem, outside the worktree. */
  writeTextFile?: (filePath: string, contents: string) => Promise<void>;
  /** User-level CODEX_HOME. Project `.codex/config.toml` ignores `openai_base_url`. */
  codexHome?: string;
  /** Defaults to the process tracer. Export stays off unless the env flags are true. */
  tracer?: StageTracer;
}

/** `agent.run` around one CodingAgent call. A non-succeeded status fails the span and still returns. */
export async function withAgentRunSpan(
  input: CodingAgentInput,
  agentId: string,
  tracer: StageTracer | undefined,
  fn: (span: ActiveSpan) => Promise<CodingAgentOutput>,
): Promise<CodingAgentOutput> {
  const active = tracer ?? getStageTracer();
  return active.runStage(
    CANONICAL_SPAN.agentRun,
    {
      taskId: input.metadata.task_id,
      worktreeId: input.metadata.worktree_id,
      attributes: {
        agent_id: agentId,
        workflow_id: input.metadata.workflow_id,
        step_id: input.metadata.step_id,
      },
    },
    async (span) => {
      const output = await fn(span);
      writeUsageSpan(span, output.usage);
      if (output.status !== "succeeded") {
        span.setAttribute("error_class", output.error_class ?? output.status);
        span.fail(output.error_class ?? output.status);
      }
      return output;
    },
  );
}

function writeUsageSpan(span: ActiveSpan, usage: CodingAgentUsage): void {
  span.setAttribute("provider", usage.provider);
  if (usage.model_id) span.setAttribute("model_id", usage.model_id);
  if (usage.input_tokens !== undefined)
    span.setAttribute("input_tokens", String(usage.input_tokens));
  if (usage.output_tokens !== undefined) {
    span.setAttribute("output_tokens", String(usage.output_tokens));
  }
  if (usage.cached_tokens !== undefined) {
    span.setAttribute("cached_tokens", String(usage.cached_tokens));
  }
  if (usage.cost_usd !== undefined) span.setAttribute("cost_usd", String(usage.cost_usd));
}

const MAX_OUTPUT_CHARS = 1_000_000;
const WRITE_TOOLS = new Set(["shell", "edit", "edit_file", "write"]);

export function buildAgentPrompt(input: CodingAgentInput): string {
  const instructions = input.instructions?.trim();
  if (!instructions) return input.prompt;
  return `${instructions}\n\n${input.prompt}`;
}

export function allowsMutation(tools: readonly string[]): boolean {
  return tools.some((tool) => WRITE_TOOLS.has(tool));
}

export function childEnv(
  parent: NodeJS.ProcessEnv,
  patch: Record<string, string | undefined>,
  strip: readonly string[],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parent };
  for (const key of strip) delete env[key];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function appendOutput(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  if (next.length <= MAX_OUTPUT_CHARS) return next;
  return next.slice(next.length - MAX_OUTPUT_CHARS);
}

/** Spawn a CLI without a shell. ENOENT becomes exit 127 instead of a thrown error. */
export function spawnCli(request: CliRunRequest): Promise<CliRunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: CliRunResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let timer: NodeJS.Timeout | undefined;
    if (request.timeoutMs !== undefined && request.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, request.timeoutMs);
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendOutput(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendOutput(stderr, chunk);
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({
        exitCode: error.code === "ENOENT" ? 127 : 1,
        stdout,
        stderr: error.message,
        timedOut,
        signal: null,
      });
    });

    child.on("close", (exitCode, signal) => {
      finish({
        exitCode,
        stdout,
        stderr,
        timedOut,
        signal,
      });
    });
  });
}

export async function invokeCli(runner: CliRunner, request: CliRunRequest): Promise<CliRunResult> {
  try {
    return await runner(request);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return {
      exitCode: err.code === "ENOENT" ? 127 : 1,
      stdout: "",
      stderr: err.message || "cli failed",
      timedOut: false,
      signal: null,
    };
  }
}

export function credentialsFailure(
  provider: string,
  input: CodingAgentInput,
  errorClass: string,
): CodingAgentOutput {
  return {
    pr_ready: false,
    status: "failed",
    error_class: errorClass,
    usage: {
      provider,
      model_id: input.metadata.model_id,
    },
  };
}

/** The CLI is not started. `logs` and `observation` are the same sentence for the agent. */
export function permissionDeniedRun(
  provider: string,
  input: CodingAgentInput,
  observation: string,
): CodingAgentOutput {
  return {
    pr_ready: false,
    status: "failed",
    error_class: "permission_denied",
    logs: observation,
    observation,
    usage: {
      provider,
      model_id: input.metadata.model_id,
    },
  };
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_tokens?: number;
  cached_input_tokens?: number;
  cost_usd?: number;
  model_id?: string;
  /** Cursor agent CLI 2026.09+ print --output-format json */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseJsonEvents(stdout: string): Record<string, unknown>[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const record = asRecord(parsed);
    return record ? [record] : [];
  } catch {
    const events: Record<string, unknown>[] = [];
    for (const line of stdout.split("\n")) {
      const text = line.trim();
      if (!text.startsWith("{")) continue;
      try {
        const record = asRecord(JSON.parse(text) as unknown);
        if (record) events.push(record);
      } catch {
        // Non-JSON progress lines are not usage.
      }
    }
    return events;
  }
}

function readUsage(event: Record<string, unknown>): RawUsage | undefined {
  const direct = asRecord(event.usage);
  if (direct) return direct as RawUsage;
  const payload = asRecord(event.payload);
  if (!payload || payload.type !== "token_count") return undefined;
  const info = asRecord(payload.info);
  const total = asRecord(info?.total_token_usage);
  return total ? (total as RawUsage) : undefined;
}

function eventText(events: Record<string, unknown>[]): string {
  const parts: string[] = [];
  for (const event of events) {
    for (const key of ["message", "error"]) {
      const value = event[key];
      if (typeof value === "string") parts.push(value);
    }
  }
  return parts.join("\n");
}

function scrub(text: string, secrets: readonly string[]): string {
  let out = redactSecrets(text);
  for (const secret of secrets) {
    if (secret.length > 0) out = out.split(secret).join("[redacted]");
  }
  return out;
}

function classify(
  result: CliRunResult,
  blob: string,
): {
  status: CodingAgentStatus;
  error_class?: string;
} {
  if (result.timedOut) return { status: "budget_exhausted", error_class: "wall_clock" };
  if (result.signal === "SIGINT" || result.signal === "SIGTERM") {
    return { status: "cancelled", error_class: "cancelled" };
  }
  if (/budget|insufficient_quota|quota exceeded/i.test(blob)) {
    return { status: "budget_exhausted", error_class: "budget_exhausted" };
  }
  if (/\b429\b|rate[_ ]limit/i.test(blob)) {
    return { status: "rate_limited", error_class: "rate_limited" };
  }
  if (result.exitCode === 127 || /ENOENT/.test(result.stderr)) {
    return { status: "failed", error_class: "cli_not_found" };
  }
  return { status: "failed", error_class: "cli_failed" };
}

export function mapCliToOutput(args: {
  provider: "cursor" | "codex";
  input: CodingAgentInput;
  result: CliRunResult;
  secrets?: readonly string[];
}): CodingAgentOutput {
  const events = parseJsonEvents(args.result.stdout);
  let raw: RawUsage | undefined;
  let sawError = false;
  let diffSummary: string | undefined;
  for (const event of events) {
    if (event.is_error === true) sawError = true;
    const usage = readUsage(event);
    if (usage) raw = usage;
    if (typeof event.diff_summary === "string") diffSummary = event.diff_summary;
  }

  const blob = `${args.result.stderr}\n${eventText(events)}`;
  let { status, error_class: errorClass } = classify(args.result, blob);
  if (status === "failed" && args.result.exitCode === 0 && !sawError) {
    status = "succeeded";
    errorClass = undefined;
  }

  const usage: CodingAgentUsage = { provider: args.provider };
  const modelId = raw?.model_id ?? args.input.metadata.model_id;
  if (modelId) usage.model_id = modelId;
  // Cursor agent CLI reports camelCase token fields and often omits USD on the
  // subscription path. Accept both shapes so budget accounting is not usage_unreported.
  const inputTokens = num(raw?.input_tokens) ?? num(raw?.inputTokens);
  const outputTokens = num(raw?.output_tokens) ?? num(raw?.outputTokens);
  const cachedTokens =
    num(raw?.cached_tokens) ?? num(raw?.cached_input_tokens) ?? num(raw?.cacheReadTokens);
  let costUsd = num(raw?.cost_usd) ?? num(raw?.costUsd);
  if (costUsd === undefined && (inputTokens !== undefined || outputTokens !== undefined)) {
    costUsd = 0;
  }
  if (inputTokens !== undefined) usage.input_tokens = inputTokens;
  if (outputTokens !== undefined) usage.output_tokens = outputTokens;
  if (cachedTokens !== undefined) usage.cached_tokens = cachedTokens;
  if (costUsd !== undefined) usage.cost_usd = costUsd;

  if (status === "succeeded" && args.input.budget.maxTokens !== undefined) {
    const reported = inputTokens !== undefined || outputTokens !== undefined;
    const total = (inputTokens ?? 0) + (outputTokens ?? 0);
    if (reported && total > args.input.budget.maxTokens) {
      status = "budget_exhausted";
      errorClass = "token_budget";
    }
  }

  if (
    status === "succeeded" &&
    args.input.budget.maxUsd !== undefined &&
    costUsd !== undefined &&
    costUsd > args.input.budget.maxUsd
  ) {
    status = "budget_exhausted";
    errorClass = "usd_budget";
  }

  const stderr = args.result.stderr.trim();
  const logs = stderr ? scrub(stderr, args.secrets ?? []).slice(0, 4000) : undefined;

  const output: CodingAgentOutput = {
    pr_ready: false,
    usage,
    status,
  };
  if (diffSummary) output.diff_summary = scrub(diffSummary, args.secrets ?? []);
  if (logs) output.logs = logs;
  if (status !== "succeeded" && errorClass) output.error_class = errorClass;
  return output;
}
