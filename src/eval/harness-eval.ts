/**
 * Regression suite for the factory path: intake → stages → pull request.
 * CI uses a mocked Cursor CLI and a mocked GitHub `open_pr`. The live fixture
 * spawns the host Cursor CLI and still does not call GitHub.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FlowJob } from "bullmq";
import { z } from "zod";
import type { CodingAgent } from "../adapters/coding-agent.js";
import { createCursorAdapter } from "../adapters/cursor/index.js";
import type { CliRunResult } from "../adapters/runtime.js";
import { InMemoryStepCursorStore } from "../orchestrator/jobs/cursor.js";
import { enqueueIntakePipeline } from "../orchestrator/jobs/enqueue-pipeline.js";
import {
  StageCredentialsError,
  createProductionStageHandler,
  type GitRunner,
  type ProductionWorktrees,
} from "../orchestrator/jobs/production-handler.js";
import { processStageJob } from "../orchestrator/jobs/run-stage.js";
import { PIPELINE_STAGES, type PipelineStage } from "../orchestrator/jobs/stages.js";
import { worktreeKey, type WorktreeHandle } from "../orchestrator/worktrees/manager.js";

const MOCK_CURSOR_KEY = "eval-cursor-key";
const MOCK_GITHUB_TOKEN = "eval-github-token";
const CASE_ORDER = [
  "happy-path-open-pr",
  "missing-credentials",
  "budget-cap",
  "cheap-cursor",
] as const;

const PullSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().url(),
});

const FixtureSchema = z
  .object({
    id: z.string().min(1),
    mode: z.enum(["mock", "live"]),
    intake: z.object({
      taskId: z.string().min(1),
      title: z.string().min(1),
      description: z.string(),
    }),
    credentials: z.enum(["present", "absent"]),
    agent: z
      .object({
        maxTokens: z.number().int().positive().optional(),
        exitCode: z.number().int().optional(),
        stdout: z.string().optional(),
        stderr: z.string().optional(),
        timedOut: z.boolean().optional(),
      })
      .optional(),
    github: z
      .object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        pull: PullSchema,
      })
      .optional(),
    expect: z.object({
      outcome: z.enum(["pr_opened", "controlled_fail"]),
      error_class: z.string().min(1).optional(),
      stages_completed: z.array(z.enum(PIPELINE_STAGES)),
      open_pr_calls: z.number().int().nonnegative(),
      cli_invoked: z.number().int().nonnegative().optional(),
      pr: PullSchema.optional(),
    }),
  })
  .superRefine((fixture, ctx) => {
    if (
      fixture.mode === "mock" &&
      fixture.credentials === "present" &&
      fixture.agent?.stdout === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mock fixture with credentials needs agent.stdout",
        path: ["agent", "stdout"],
      });
    }
    if (fixture.expect.outcome === "pr_opened" && !fixture.expect.pr) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "pr_opened requires expect.pr",
        path: ["expect", "pr"],
      });
    }
    if (fixture.expect.outcome === "pr_opened" && !fixture.github) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "pr_opened requires a github mock",
        path: ["github"],
      });
    }
  });

export type EvalFixture = z.infer<typeof FixtureSchema>;

export interface EvalCaseReport {
  id: string;
  status: "pass" | "fail";
  expected: string;
  actual: string;
}

export interface EvalReport {
  suite: "harness-eval";
  mode: "mock" | "live";
  ok: boolean;
  passed: number;
  failed: number;
  cases: EvalCaseReport[];
}

interface Observed {
  outcome: "pr_opened" | "controlled_fail";
  errorClass?: string;
  stages: PipelineStage[];
  openPrCalls: number;
  cliInvoked: number;
  pr?: { number: number; url: string };
}

export async function loadEvalFixtures(
  dir: string,
  filter?: { mode?: EvalFixture["mode"]; ids?: readonly string[] },
): Promise<EvalFixture[]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  const fixtures: EvalFixture[] = [];
  for (const name of names) {
    const raw: unknown = JSON.parse(await readFile(path.join(dir, name), "utf8"));
    const parsed = FixtureSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`invalid eval fixture ${name}: ${parsed.error.message}`);
    }
    fixtures.push(parsed.data);
  }
  return fixtures.filter((fixture) => {
    if (filter?.mode && fixture.mode !== filter.mode) return false;
    if (filter?.ids && !filter.ids.includes(fixture.id)) return false;
    return true;
  });
}

export function renderEvalReport(report: EvalReport): string {
  const head = `harness-eval mode=${report.mode} passed=${report.passed} failed=${report.failed}`;
  const lines = report.cases.map((row) => {
    const label = row.status === "pass" ? "PASS" : "FAIL";
    return `${label} ${row.id} expected=${row.expected} actual=${row.actual}`;
  });
  return `${[head, ...lines].join("\n")}\n`;
}

export async function writeEvalReport(
  report: EvalReport,
  dir: string,
): Promise<{ jsonPath: string; textPath: string }> {
  await mkdir(dir, { recursive: true });
  const jsonPath = path.join(dir, "harness-eval.json");
  const textPath = path.join(dir, "harness-eval.txt");
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(textPath, renderEvalReport(report), "utf8");
  return { jsonPath, textPath };
}

export async function runHarnessEval(options: {
  fixtures: readonly EvalFixture[];
  mode: "mock" | "live";
}): Promise<EvalReport> {
  const fixtures = sortFixtures(options.fixtures);
  const cases: EvalCaseReport[] = [];
  for (const fixture of fixtures) {
    cases.push(await scoreFixture(fixture));
  }
  const failed = cases.filter((row) => row.status === "fail").length;
  return {
    suite: "harness-eval",
    mode: options.mode,
    ok: failed === 0,
    passed: cases.length - failed,
    failed,
    cases,
  };
}

function sortFixtures(fixtures: readonly EvalFixture[]): EvalFixture[] {
  return [...fixtures].sort((a, b) => {
    const ai = CASE_ORDER.indexOf(a.id as (typeof CASE_ORDER)[number]);
    const bi = CASE_ORDER.indexOf(b.id as (typeof CASE_ORDER)[number]);
    const an = ai === -1 ? CASE_ORDER.length : ai;
    const bn = bi === -1 ? CASE_ORDER.length : bi;
    return an - bn || a.id.localeCompare(b.id);
  });
}

async function scoreFixture(fixture: EvalFixture): Promise<EvalCaseReport> {
  const expected = summarizeExpect(fixture);
  try {
    const observed = await executeFixture(fixture);
    const problems = compare(fixture, observed);
    return {
      id: fixture.id,
      status: problems.length === 0 ? "pass" : "fail",
      expected,
      actual: redact(summarizeObserved(observed), secretsFor(fixture)),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      id: fixture.id,
      status: "fail",
      expected,
      actual: redact(`controlled_fail error_class=runner stages=- ${message}`, secretsFor(fixture)),
    };
  }
}

function compare(fixture: EvalFixture, observed: Observed): string[] {
  const problems: string[] = [];
  const expect = fixture.expect;
  if (observed.outcome !== expect.outcome) problems.push("outcome");
  if ((observed.errorClass ?? "") !== (expect.error_class ?? "")) problems.push("error_class");
  if (observed.stages.join(",") !== expect.stages_completed.join(",")) problems.push("stages");
  if (observed.openPrCalls !== expect.open_pr_calls) problems.push("open_pr_calls");
  if (expect.cli_invoked !== undefined && observed.cliInvoked !== expect.cli_invoked) {
    problems.push("cli_invoked");
  }
  if (expect.pr) {
    if (observed.pr?.number !== expect.pr.number || observed.pr?.url !== expect.pr.url) {
      problems.push("pr");
    }
  } else if (observed.pr) {
    problems.push("pr");
  }
  return problems;
}

function summarizeExpect(fixture: EvalFixture): string {
  return summarize({
    outcome: fixture.expect.outcome,
    errorClass: fixture.expect.error_class,
    stages: fixture.expect.stages_completed,
    openPrCalls: fixture.expect.open_pr_calls,
    cliInvoked: fixture.expect.cli_invoked,
    pr: fixture.expect.pr,
  });
}

function summarizeObserved(observed: Observed): string {
  return summarize(observed);
}

function summarize(input: {
  outcome: Observed["outcome"];
  errorClass?: string;
  stages: readonly string[];
  openPrCalls: number;
  cliInvoked?: number;
  pr?: { number: number; url: string };
}): string {
  const stages = input.stages.join(",") || "-";
  const errorClass = input.errorClass ? ` error_class=${input.errorClass}` : "";
  const cli = input.cliInvoked === undefined ? "" : ` cli_invoked=${input.cliInvoked}`;
  const pr = input.pr ? ` pr=${input.pr.number} ${input.pr.url}` : "";
  return `${input.outcome}${errorClass} stages=${stages} open_pr_calls=${input.openPrCalls}${cli}${pr}`;
}

async function executeFixture(fixture: EvalFixture): Promise<Observed> {
  const root = await mkdtemp(path.join(tmpdir(), "optio-eval-"));
  const handle: WorktreeHandle = {
    taskId: fixture.intake.taskId,
    worktreeId: `wt-${fixture.intake.taskId}`,
    path: path.join(root, `wt-${fixture.intake.taskId}`),
    branch: `task/${fixture.intake.taskId}`,
  };
  await mkdir(handle.path, { recursive: true });
  let ready = false;
  const worktrees: ProductionWorktrees = {
    async create() {
      ready = true;
      return handle;
    },
    async status() {
      return ready ? handle : undefined;
    },
    async reap(taskId, outcome) {
      return {
        taskId,
        action: "reaped",
        path: handle.path,
        reason: outcome.merged ? "merged" : "failure",
      };
    },
  };

  const cliCalls = { n: 0 };
  const openPrCalls = { n: 0 };
  const env = fixtureEnv(fixture);
  const codingAgent = fixtureAgent(fixture, env, cliCalls);
  const handler = createProductionStageHandler({
    env,
    worktrees,
    codingAgent,
    fetchImpl: githubFetch(fixture, openPrCalls),
    git: gitRunner(),
    maxTokens: fixture.agent?.maxTokens,
    agentTimeoutMs: fixture.mode === "live" ? liveTimeoutMs() : 1_000,
    // The eval worktree is a temp directory, not a git checkout. The gate still
    // runs; this fixture evidence is a clean diff and green checks.
    loadPrSafety: async () => ({
      checks: {
        test: { exitCode: 0 },
        lint: { exitCode: 0 },
        typecheck: { exitCode: 0 },
      },
      diff: "",
    }),
  });

  try {
    const enqueued: FlowJob[] = [];
    await enqueueIntakePipeline(fixture.intake, {
      async add(flow) {
        enqueued.push(flow);
      },
    });
    const flow = enqueued[0];
    if (!flow) throw new Error("intake did not enqueue a pipeline");

    const cursors = new InMemoryStepCursorStore();
    const stages: PipelineStage[] = [];
    let error: unknown;
    const originalLog = console.log;
    console.log = () => undefined;
    try {
      for (const job of leafFirst(flow)) {
        await processStageJob(job.data, { cursors, handler, worktrees });
        const stage = job.data.stage;
        if (isStage(stage)) stages.push(stage);
      }
    } catch (caught) {
      error = caught;
    } finally {
      console.log = originalLog;
    }

    const pr = await readPullRecord(handle);
    return {
      outcome: error ? "controlled_fail" : "pr_opened",
      errorClass: errorClass(error),
      stages,
      openPrCalls: openPrCalls.n,
      cliInvoked: cliCalls.n,
      pr,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function fixtureEnv(fixture: EvalFixture): NodeJS.ProcessEnv {
  if (fixture.credentials === "absent") return { OPTIO_NEW_BASE_BRANCH: "development" };
  const env: NodeJS.ProcessEnv = {
    OPTIO_NEW_BASE_BRANCH: "development",
    OPTIO_NEW_CODING_BACKEND: "cursor",
  };
  if (fixture.mode === "live") {
    const key = process.env.CURSOR_API_KEY?.trim();
    if (key) env.CURSOR_API_KEY = key;
    const bin = process.env.CURSOR_AGENT_BIN?.trim();
    if (bin) env.CURSOR_AGENT_BIN = bin;
  } else {
    env.CURSOR_API_KEY = MOCK_CURSOR_KEY;
  }
  if (fixture.github) {
    env.OPTIO_NEW_GITHUB_TOKEN = MOCK_GITHUB_TOKEN;
    env.OPTIO_NEW_GITHUB_REPO = `${fixture.github.owner}/${fixture.github.repo}`;
  }
  return env;
}

function fixtureAgent(
  fixture: EvalFixture,
  env: NodeJS.ProcessEnv,
  cliCalls: { n: number },
): CodingAgent | undefined {
  if (fixture.mode === "live" || fixture.credentials === "absent") return undefined;
  const script = fixture.agent;
  if (!script) return undefined;
  return createCursorAdapter({
    env,
    runner: async (): Promise<CliRunResult> => {
      cliCalls.n += 1;
      return {
        exitCode: script.exitCode ?? 0,
        stdout: script.stdout ?? "",
        stderr: script.stderr ?? "",
        timedOut: script.timedOut ?? false,
        signal: null,
      };
    },
  });
}

function githubFetch(fixture: EvalFixture, calls: { n: number }): typeof fetch {
  const pull = fixture.github?.pull;
  return async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "GET" && url.includes("/pulls?") && url.includes("state=open")) {
      return jsonResponse(200, []);
    }
    if (method === "POST" && url.endsWith("/pulls")) {
      calls.n += 1;
      if (!pull) return jsonResponse(500, { message: "no mock pull request" });
      return jsonResponse(201, { html_url: pull.url, number: pull.number });
    }
    if (method === "GET" && url.includes("/commits/") && url.endsWith("/status")) {
      return jsonResponse(200, { state: "success" });
    }
    if (method === "GET" && url.includes("/actions/runs")) {
      return jsonResponse(200, { total_count: 0, workflow_runs: [] });
    }
    if (method === "GET" && url.includes("/check-runs")) {
      return jsonResponse(200, { total_count: 0, check_runs: [] });
    }
    if (method === "PUT" && url.endsWith("/merge")) {
      return jsonResponse(200, { merged: true });
    }
    return jsonResponse(500, { message: "unexpected github request" });
  };
}

function gitRunner(): GitRunner {
  return async (_cwd, args) => {
    const command = args[0] === "-c" ? "commit" : args[0];
    if (command === "rev-list") return "1";
    if (command === "rev-parse") return "abc123";
    if (command === "push" || command === "status" || command === "add" || command === "commit") {
      return "";
    }
    throw new Error(`unexpected git ${command ?? "command"}`);
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function leafFirst(flow: FlowJob): FlowJob[] {
  const child = flow.children?.[0] as FlowJob | undefined;
  return child ? [...leafFirst(child), flow] : [flow];
}

function isStage(value: unknown): value is PipelineStage {
  return typeof value === "string" && (PIPELINE_STAGES as readonly string[]).includes(value);
}

function errorClass(error: unknown): string | undefined {
  if (!error) return undefined;
  if (error instanceof StageCredentialsError) return error.error_class;
  const message = error instanceof Error ? error.message : String(error);
  const marked = message.match(/\(([^)]+)\)\s*$/);
  if (message.includes("budget_exhausted") && marked?.[1]) return marked[1];
  return "failed";
}

async function readPullRecord(
  handle: WorktreeHandle,
): Promise<{ number: number; url: string } | undefined> {
  try {
    const file = path.join(path.dirname(handle.path), ".prs", `${worktreeKey(handle.taskId)}.json`);
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return undefined;
    const row = parsed as { url?: unknown; number?: unknown };
    if (typeof row.url !== "string" || typeof row.number !== "number") return undefined;
    return { url: row.url, number: row.number };
  } catch {
    return undefined;
  }
}

function liveTimeoutMs(): number {
  const raw = process.env.HARNESS_EVAL_LIVE_TIMEOUT_MS?.trim();
  const parsed = raw ? Number(raw) : 120_000;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
}

function secretsFor(fixture: EvalFixture): string[] {
  const secrets = [MOCK_CURSOR_KEY, MOCK_GITHUB_TOKEN];
  if (fixture.mode === "live") {
    const key = process.env.CURSOR_API_KEY?.trim();
    if (key) secrets.push(key);
  }
  return secrets;
}

function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
}
