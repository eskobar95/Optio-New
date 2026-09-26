/**
 * Production stage handler for the orchestrator process.
 * Coding steps use resolveCodingBackend / createCursorAdapter when CURSOR_API_KEY is set.
 * Planner falls through to createAgentStageHandler only when that key is absent.
 * createEnvModelAdapter performs no HTTP, so that fall-through fails closed.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import type { CodingAgent, CodingAgentInput } from "../../adapters/coding-agent.js";
import { createCodingAgent, resolveCodingBackend } from "../../adapters/select.js";
import type { ModelAdapter } from "../../agent/adapter.js";
import { createEnvModelAdapter } from "../../agent/env-adapter.js";
import {
  GithubRequestError,
  mergeGithubPullRequest,
  openGithubPullRequest,
  parseGithubRepo,
  readCommitStatus,
  redact,
  type PullRequestRef,
} from "../github/pull-request.js";
import { worktreeKey, type WorktreeHandle, type WorktreeLifecycle } from "../worktrees/manager.js";
import {
  createAgentStageHandler,
  type StageStepContext,
  type StageStepHandler,
} from "./run-stage.js";

export class StageCredentialsError extends Error {
  readonly error_class = "missing_credentials";

  constructor(message: string) {
    super(message);
    this.name = "StageCredentialsError";
  }
}

export interface ProductionWorktrees extends WorktreeLifecycle {
  status(taskId: string): Promise<WorktreeHandle | undefined>;
}

export type GitRunner = (cwd: string, args: readonly string[]) => Promise<string>;

export interface ProductionStageOptions {
  env?: NodeJS.ProcessEnv;
  worktrees: ProductionWorktrees;
  modelAdapter?: ModelAdapter;
  codingAgent?: CodingAgent;
  fetchImpl?: typeof fetch;
  git?: GitRunner;
  /** Wall clock for one coding-agent invocation. Default 15 minutes. */
  agentTimeoutMs?: number;
  /**
   * Token cap forwarded on each coding-agent call.
   * Unset leaves the adapter's token check off. A total above this cap
   * returns `budget_exhausted` / `token_budget` and fails the step.
   */
  maxTokens?: number;
}

const E2E_TASK = /^e2e-[A-Za-z0-9._-]+$/;
const AGENT_TIMEOUT_MS = 15 * 60 * 1000;

interface StoredPullRequest extends PullRequestRef {
  head: string;
  base: string;
}

export function createProductionStageHandler(options: ProductionStageOptions): StageStepHandler {
  const env = options.env ?? process.env;
  const worktrees = options.worktrees;
  const runGit = options.git ?? execGit;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.agentTimeoutMs ?? AGENT_TIMEOUT_MS;
  const model = options.modelAdapter ?? createEnvModelAdapter(env);
  const plannerLoop = createAgentStageHandler(model);
  const baseBranch = env.OPTIO_NEW_BASE_BRANCH?.trim() || "development";

  return {
    async run(ctx) {
      switch (ctx.step) {
        case "ack_session":
        case "record_cleanup":
          return;
        case "invoke_planner":
          await runPlanner(ctx);
          return;
        case "invoke_implementation":
        case "invoke_review":
          await runCoding(ctx);
          return;
        case "record_diff":
        case "record_verdict":
          await recordGitSummary(ctx);
          return;
        case "open_pr":
          await openPullRequest(ctx);
          return;
        case "record_ci_wait":
          await waitForCi(ctx);
          return;
        case "merge_branch":
          await mergePullRequest(ctx);
          return;
        default:
          throw new Error(`unknown step ${ctx.stage}:${ctx.step}`);
      }
    },
  };

  async function runPlanner(ctx: StageStepContext): Promise<void> {
    if (env.CURSOR_API_KEY?.trim()) {
      await runCoding(ctx);
      return;
    }
    const modelKey = env.MODEL_API_KEY?.trim() ?? "";
    const endpoint = env.MODEL_ENDPOINT?.trim() ?? "";
    if (!modelKey || !endpoint) {
      throw new StageCredentialsError(
        "invoke_planner requires CURSOR_API_KEY, or MODEL_API_KEY and MODEL_ENDPOINT. createEnvModelAdapter performs no HTTP, so set CURSOR_API_KEY to run the planner through the Cursor coding agent.",
      );
    }
    try {
      await plannerLoop.run(ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("does not perform HTTP") || message.includes("performs no HTTP")) {
        throw new StageCredentialsError(
          "MODEL_API_KEY and MODEL_ENDPOINT are set. createEnvModelAdapter performs no HTTP, so invoke_planner cannot finish on that adapter. Set CURSOR_API_KEY to run the planner through the Cursor coding agent.",
        );
      }
      throw error;
    }
  }

  async function runCoding(ctx: StageStepContext): Promise<void> {
    const backend = resolveCodingBackend({
      defaultBackend: env.OPTIO_NEW_CODING_BACKEND?.trim() || "cursor",
    });
    if (backend === "cursor" && !env.CURSOR_API_KEY?.trim()) {
      throw new StageCredentialsError("CURSOR_API_KEY is required for the Cursor coding agent");
    }
    const handle = await ensureWorktree(ctx.taskId);
    const agent = options.codingAgent ?? createCodingAgent(backend, { env });
    const output = await agent.run(codingInput(ctx, handle, timeoutMs, options.maxTokens));
    if (output.status === "succeeded") return;
    if (output.error_class === "missing_credentials") {
      throw new StageCredentialsError(
        `coding agent ${backend} is missing credentials (${output.error_class})`,
      );
    }
    const detail = output.logs ? `: ${output.logs.slice(0, 500)}` : "";
    throw new Error(
      `coding agent ${backend} ${output.status} (${output.error_class ?? "failed"})${detail}`,
    );
  }

  async function ensureWorktree(taskId: string): Promise<WorktreeHandle> {
    const existing = await worktrees.status(taskId);
    if (existing) return existing;
    return worktrees.create(taskId);
  }

  async function recordGitSummary(ctx: StageStepContext): Promise<void> {
    const handle = await requireWorktree(ctx);
    const summary = await git(handle.path, ["status", "--short"], []);
    console.log(
      JSON.stringify({
        msg: "git summary",
        taskId: ctx.taskId,
        stage: ctx.stage,
        step: ctx.step,
        summary,
      }),
    );
  }

  async function openPullRequest(ctx: StageStepContext): Promise<void> {
    const github = requireGithub();
    const handle = await requireWorktree(ctx);
    const token = github.token;
    const ahead = await commitCount(handle.path, token);
    if (ahead === 0) {
      if (!E2E_TASK.test(ctx.taskId)) {
        throw new Error(`open_pr: ${ctx.taskId} has no commits ahead of ${baseBranch}`);
      }
      await writeE2eMarker(handle, ctx.taskId, token);
    }
    const remote = `https://x-access-token:${encodeURIComponent(token)}@github.com/${github.owner}/${github.repo}.git`;
    await git(handle.path, ["push", remote, `${handle.branch}:${handle.branch}`], [token]);
    const title = E2E_TASK.test(ctx.taskId)
      ? `e2e: ${ctx.taskId}`
      : ctx.title?.trim() || `task ${ctx.taskId}`;
    const opened = await mapGithub(() =>
      openGithubPullRequest({
        token,
        owner: github.owner,
        repo: github.repo,
        title,
        head: handle.branch,
        base: baseBranch,
        body: pullBody(ctx, baseBranch),
        fetchImpl,
      }),
    );
    await writePullRecord(handle, { ...opened, head: handle.branch, base: baseBranch });
    console.log(
      JSON.stringify({
        msg: "pull request opened",
        taskId: ctx.taskId,
        url: opened.url,
        number: opened.number,
      }),
    );
  }

  async function waitForCi(ctx: StageStepContext): Promise<void> {
    const github = requireGithub();
    const handle = await requireWorktree(ctx);
    const sha = await git(handle.path, ["rev-parse", "HEAD"], [github.token]);
    const state = await mapGithub(() =>
      readCommitStatus({
        token: github.token,
        owner: github.owner,
        repo: github.repo,
        sha,
        fetchImpl,
      }),
    );
    if (state !== "success") {
      throw new Error(`ci ${state} for ${ctx.taskId}`);
    }
  }

  async function mergePullRequest(ctx: StageStepContext): Promise<void> {
    if (E2E_TASK.test(ctx.taskId)) {
      console.log(JSON.stringify({ msg: "e2e pull request left unmerged", taskId: ctx.taskId }));
      return;
    }
    const github = requireGithub();
    const handle = await requireWorktree(ctx);
    const stored = await readPullRecord(handle);
    await mapGithub(() =>
      mergeGithubPullRequest({
        token: github.token,
        owner: github.owner,
        repo: github.repo,
        number: stored.number,
        fetchImpl,
      }),
    );
    console.log(
      JSON.stringify({ msg: "pull request merged", taskId: ctx.taskId, number: stored.number }),
    );
  }

  async function writeE2eMarker(
    handle: WorktreeHandle,
    taskId: string,
    token: string,
  ): Promise<void> {
    const relative = path.join("e2e", `${taskId}.md`);
    const root = path.resolve(handle.path);
    const absolute = path.resolve(root, relative);
    const escaped = path.relative(root, absolute);
    if (escaped.startsWith("..") || path.isAbsolute(escaped)) {
      throw new Error(`open_pr: marker path escaped the worktree for ${taskId}`);
    }
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(
      absolute,
      `# e2e marker\n\nTask \`${taskId}\` is a throwaway intake proof. Do not merge this pull request.\n`,
      "utf8",
    );
    await git(handle.path, ["add", "--", relative], [token]);
    await git(
      handle.path,
      [
        "-c",
        "user.name=optio-new",
        "-c",
        "user.email=optio-new@users.noreply.github.com",
        "commit",
        "-m",
        `e2e: marker for ${taskId}`,
      ],
      [token],
    );
  }

  async function commitCount(cwd: string, token: string): Promise<number> {
    const raw = await git(cwd, ["rev-list", "--count", `${baseBranch}..HEAD`], [token]);
    const count = Number(raw);
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`open_pr: could not count commits ahead of ${baseBranch}`);
    }
    return count;
  }

  function requireGithub(): { token: string; owner: string; repo: string } {
    const token = env.OPTIO_NEW_GITHUB_TOKEN?.trim() ?? "";
    const repoSpec = env.OPTIO_NEW_GITHUB_REPO?.trim() ?? "";
    if (!token || !repoSpec) {
      throw new StageCredentialsError(
        "open_pr requires OPTIO_NEW_GITHUB_TOKEN and OPTIO_NEW_GITHUB_REPO (owner/repo)",
      );
    }
    const parsed = parseGithubRepo(repoSpec);
    return { token, owner: parsed.owner, repo: parsed.repo };
  }

  async function requireWorktree(ctx: StageStepContext): Promise<WorktreeHandle> {
    const handle = await worktrees.status(ctx.taskId);
    if (!handle) throw new Error(`${ctx.stage}:${ctx.step} requires a worktree for ${ctx.taskId}`);
    return handle;
  }

  async function git(
    cwd: string,
    args: readonly string[],
    secrets: readonly string[],
  ): Promise<string> {
    try {
      return await runGit(cwd, args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(redact(message, secrets));
    }
  }

  async function mapGithub<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof GithubRequestError && (error.status === 401 || error.status === 403)) {
        throw new StageCredentialsError(
          "OPTIO_NEW_GITHUB_TOKEN was rejected by GitHub. Check the token in the host sops env.",
        );
      }
      throw error;
    }
  }
}

function codingInput(
  ctx: StageStepContext,
  handle: WorktreeHandle,
  timeoutMs: number,
  maxTokens?: number,
): CodingAgentInput {
  const review = ctx.step === "invoke_review";
  return {
    worktree_path: handle.path,
    prompt: taskPrompt(ctx),
    instructions: review
      ? "Review the worktree diff. Do not edit files, push, open a pull request, or merge."
      : "Implement the task in this worktree and commit on the current branch. Do not push, open a pull request, or merge.",
    allowed_tools: review ? ["read"] : ["shell", "edit", "write"],
    budget:
      maxTokens === undefined
        ? { maxWallClockMs: timeoutMs }
        : { maxWallClockMs: timeoutMs, maxTokens },
    metadata: {
      task_id: ctx.taskId,
      worktree_id: handle.worktreeId,
      workflow_id: "default-task",
      step_id: ctx.step,
      agent_id: `agents/${ctx.stage}`,
    },
  };
}

function taskPrompt(ctx: StageStepContext): string {
  const lines = [`Task ${ctx.taskId}.`, `Step ${ctx.stage}:${ctx.step}.`];
  const title = ctx.title?.trim();
  const description = ctx.description?.trim();
  if (title) lines.push(`Title: ${title}`);
  if (description) lines.push(`Description: ${description.slice(0, 4000)}`);
  return lines.join("\n");
}

function pullBody(ctx: StageStepContext, base: string): string {
  const lines = [
    `Opened by the Optio-New orchestrator for task \`${ctx.taskId}\`.`,
    `Target branch: \`${base}\`.`,
  ];
  const title = ctx.title?.trim();
  const description = ctx.description?.trim();
  if (title) lines.push("", title);
  if (description) lines.push("", description.slice(0, 4000));
  if (E2E_TASK.test(ctx.taskId)) {
    lines.push("", "Throwaway e2e task. The orchestrator leaves this pull request unmerged.");
  }
  return lines.join("\n");
}

function recordPath(handle: WorktreeHandle): string {
  return path.join(path.dirname(handle.path), ".prs", `${worktreeKey(handle.taskId)}.json`);
}

async function writePullRecord(handle: WorktreeHandle, record: StoredPullRequest): Promise<void> {
  const file = recordPath(handle);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(record)}\n`, "utf8");
}

async function readPullRecord(handle: WorktreeHandle): Promise<StoredPullRequest> {
  try {
    const parsed: unknown = JSON.parse(await readFile(recordPath(handle), "utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error("empty");
    const row = parsed as StoredPullRequest;
    if (
      typeof row.url !== "string" ||
      typeof row.number !== "number" ||
      typeof row.head !== "string"
    ) {
      throw new Error("shape");
    }
    return row;
  } catch {
    throw new Error(`merge_branch: no pull request record for ${handle.taskId}`);
  }
}

export function execGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || "").trim() || error.message));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}
