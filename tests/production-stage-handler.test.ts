import { mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CodingAgent, CodingAgentInput } from "../src/adapters/coding-agent.js";
import type { FlowJob } from "bullmq";
import {
  InMemoryStepCursorStore,
  StageCredentialsError,
  createProductionStageHandler,
  enqueueIntakePipeline,
  processStageJob,
  runPipeline,
  type ProductionWorktrees,
  type StageStepContext,
} from "../src/index.js";
import type { WorktreeHandle } from "../src/orchestrator/worktrees/manager.js";

const TOKEN = "test-github-token";

function step(stage: StageStepContext["stage"], name: string, taskId: string): StageStepContext {
  return { taskId, sessionId: taskId, stage, step: name, stepIndex: 0 };
}

function worktreeFixture(taskId: string, created = false) {
  const root = mkdtempSync(join(tmpdir(), "optio-pr-"));
  const handle: WorktreeHandle = {
    taskId,
    worktreeId: `wt-${taskId}`,
    path: join(root, `wt-${taskId}`),
    branch: `task/${taskId}`,
  };
  mkdirSync(handle.path, { recursive: true });
  let ready = created;
  const worktrees: ProductionWorktrees = {
    async create() {
      ready = true;
      return handle;
    },
    async status() {
      return ready ? handle : undefined;
    },
    async reap(id, outcome) {
      return {
        taskId: id,
        action: "reaped",
        path: handle.path,
        reason: outcome.merged ? "merged" : "failure",
      };
    },
  };
  return { handle, worktrees };
}

function codingAgent(calls: CodingAgentInput[]): CodingAgent {
  return {
    id: "cursor",
    async run(input) {
      calls.push(input);
      return { pr_ready: false, status: "succeeded", usage: { provider: "cursor" } };
    },
  };
}

function gitRunner(counts: { ahead: string }) {
  const calls: string[] = [];
  return {
    calls,
    git: async (_cwd: string, args: readonly string[]) => {
      calls.push(args.join(" "));
      const command = args[0] === "-c" ? "commit" : args[0];
      if (command === "rev-list") return counts.ahead;
      if (command === "rev-parse") return "abc123";
      if (command === "push" || command === "add" || command === "commit" || command === "status") {
        return "";
      }
      throw new Error(`unexpected git ${args.join(" ")}`);
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function githubFetch(extra?: { onPost?: () => Response }) {
  const calls: { url: string; method: string }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (method === "POST" && url.endsWith("/pulls")) {
      return (
        extra?.onPost?.() ??
        jsonResponse(201, { html_url: "https://github.com/acme/widgets/pull/7", number: 7 })
      );
    }
    if (method === "GET" && url.includes("/commits/") && url.endsWith("/status")) {
      return jsonResponse(200, { state: "success" });
    }
    if (method === "PUT" && url.endsWith("/merge")) {
      return jsonResponse(200, { merged: true });
    }
    return jsonResponse(500, { message: "unexpected" });
  };
  return { fetchImpl, calls };
}

function handlerEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    CURSOR_API_KEY: "cursor-test",
    OPTIO_NEW_GITHUB_TOKEN: TOKEN,
    OPTIO_NEW_GITHUB_REPO: "acme/widgets",
    OPTIO_NEW_BASE_BRANCH: "development",
    ...overrides,
  };
}

describe("production stage handler", () => {
  it("fails planner closed when Cursor and model credentials are absent", async () => {
    const { worktrees } = worktreeFixture("task-1");
    const handler = createProductionStageHandler({ env: {}, worktrees });
    await expect(handler.run(step("plan", "invoke_planner", "task-1"))).rejects.toBeInstanceOf(
      StageCredentialsError,
    );
    await expect(handler.run(step("plan", "invoke_planner", "task-1"))).rejects.toThrow(
      /CURSOR_API_KEY/,
    );
  });

  it("fails planner closed when only MODEL_API_KEY is set, because the env adapter performs no HTTP", async () => {
    const { worktrees } = worktreeFixture("task-1");
    const handler = createProductionStageHandler({
      env: { MODEL_API_KEY: "sk-test", MODEL_ENDPOINT: "http://127.0.0.1:4000/v1" },
      worktrees,
    });
    await expect(handler.run(step("plan", "invoke_planner", "task-1"))).rejects.toThrow(
      /performs no HTTP/,
    );
  });

  it("runs the Cursor coding agent for planner when CURSOR_API_KEY is set", async () => {
    const calls: CodingAgentInput[] = [];
    let modelCalled = false;
    const { worktrees } = worktreeFixture("task-1");
    const handler = createProductionStageHandler({
      env: handlerEnv(),
      worktrees,
      codingAgent: codingAgent(calls),
      modelAdapter: {
        async complete() {
          modelCalled = true;
          return { text: "nope" };
        },
      },
    });
    await handler.run({
      ...step("plan", "invoke_planner", "task-1"),
      title: "Open a PR",
      description: "marker only",
    });
    expect(modelCalled).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.metadata.step_id).toBe("invoke_planner");
    expect(calls[0]?.prompt).toContain("Open a PR");
    expect(calls[0]?.prompt).toContain("marker only");
    expect(calls[0]?.allowed_tools).toEqual(["shell", "edit", "write"]);
  });

  it("fails a missing Cursor CLI instead of acking the step", async () => {
    const { worktrees } = worktreeFixture("task-1");
    const handler = createProductionStageHandler({
      env: handlerEnv(),
      worktrees,
      codingAgent: {
        id: "cursor",
        async run() {
          return {
            pr_ready: false,
            status: "failed",
            error_class: "cli_not_found",
            logs: "spawn agent ENOENT",
            usage: { provider: "cursor" },
          };
        },
      },
    });
    await expect(handler.run(step("implement", "invoke_implementation", "task-1"))).rejects.toThrow(
      /cli_not_found/,
    );
  });

  it("opens a pull request and merges a non-e2e branch", async () => {
    const taskId = "ship-1";
    const { worktrees } = worktreeFixture(taskId);
    const agentCalls: CodingAgentInput[] = [];
    const git = gitRunner({ ahead: "1" });
    const github = githubFetch();
    const handler = createProductionStageHandler({
      env: handlerEnv(),
      worktrees,
      codingAgent: codingAgent(agentCalls),
      git: git.git,
      fetchImpl: github.fetchImpl,
    });
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map((part) => String(part)).join(" "));
    };
    let result: Awaited<ReturnType<typeof runPipeline>>;
    try {
      result = await runPipeline(
        { taskId, sessionId: taskId },
        { cursors: new InMemoryStepCursorStore(), handler, worktrees },
      );
    } finally {
      console.log = originalLog;
    }
    expect(result.stages.map((stage) => stage.stage)).toEqual([
      "plan",
      "implement",
      "review",
      "ready",
      "merge",
    ]);
    expect(agentCalls.map((call) => call.metadata.step_id)).toEqual([
      "invoke_planner",
      "invoke_implementation",
      "invoke_review",
    ]);
    expect(agentCalls[2]?.allowed_tools).toEqual(["read"]);
    expect(github.calls.some((call) => call.method === "POST" && call.url.endsWith("/pulls"))).toBe(
      true,
    );
    expect(github.calls.some((call) => call.method === "PUT" && call.url.endsWith("/merge"))).toBe(
      true,
    );
    expect(git.calls.some((call) => call.startsWith("push ") && call.includes(TOKEN))).toBe(true);
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("writes an e2e marker commit, opens a pull request, and does not merge", async () => {
    const taskId = "e2e-marker";
    const { handle, worktrees } = worktreeFixture(taskId, true);
    const git = gitRunner({ ahead: "0" });
    const github = githubFetch();
    const handler = createProductionStageHandler({
      env: handlerEnv(),
      worktrees,
      git: git.git,
      fetchImpl: github.fetchImpl,
    });
    await handler.run(step("ready", "open_pr", taskId));
    expect(existsSync(join(handle.path, "e2e", `${taskId}.md`))).toBe(true);
    expect(git.calls.some((call) => call.startsWith("add "))).toBe(true);
    expect(git.calls.some((call) => call.includes("commit"))).toBe(true);
    expect(github.calls.some((call) => call.method === "POST")).toBe(true);
    github.calls.length = 0;
    await handler.run(step("merge", "merge_branch", taskId));
    expect(github.calls).toEqual([]);
  });

  it("refuses to invent a commit for a non-e2e task", async () => {
    const taskId = "ship-empty";
    const { worktrees } = worktreeFixture(taskId, true);
    const git = gitRunner({ ahead: "0" });
    const handler = createProductionStageHandler({
      env: handlerEnv(),
      worktrees,
      git: git.git,
      fetchImpl: githubFetch().fetchImpl,
    });
    await expect(handler.run(step("ready", "open_pr", taskId))).rejects.toThrow(/no commits ahead/);
    expect(git.calls.some((call) => call.startsWith("add "))).toBe(false);
  });

  it("redacts the GitHub token when push fails", async () => {
    const taskId = "ship-2";
    const { worktrees } = worktreeFixture(taskId, true);
    const handler = createProductionStageHandler({
      env: handlerEnv(),
      worktrees,
      git: async (_cwd, args) => {
        if (args[0] === "rev-list") return "1";
        throw new Error(`push failed https://x-access-token:${TOKEN}@github.com/acme/widgets.git`);
      },
    });
    await expect(handler.run(step("ready", "open_pr", taskId))).rejects.toThrow(/\[redacted\]/);
    await expect(handler.run(step("ready", "open_pr", taskId))).rejects.not.toThrow(TOKEN);
  });

  it("maps a rejected GitHub token to a credentials error", async () => {
    const taskId = "ship-3";
    const { worktrees } = worktreeFixture(taskId, true);
    const handler = createProductionStageHandler({
      env: handlerEnv(),
      worktrees,
      git: gitRunner({ ahead: "1" }).git,
      fetchImpl: async () => jsonResponse(401, { message: TOKEN }),
    });
    await expect(handler.run(step("ready", "open_pr", taskId))).rejects.toBeInstanceOf(
      StageCredentialsError,
    );
  });

  it("puts the intake brief on every stage job", async () => {
    const added: FlowJob[] = [];
    await enqueueIntakePipeline(
      { taskId: "e2e-brief", title: "Open a PR", description: "marker only" },
      {
        async add(flow) {
          added.push(flow);
        },
      },
    );
    const root = added[0];
    expect(root?.data).toMatchObject({
      title: "Open a PR",
      description: "marker only",
      stage: "merge",
    });
    let leaf = root;
    while (leaf?.children?.[0]) leaf = leaf.children[0] as FlowJob;
    expect(leaf?.data).toMatchObject({ title: "Open a PR", stage: "plan" });
  });

  it("passes the intake title through to the planner prompt", async () => {
    const calls: CodingAgentInput[] = [];
    const { worktrees } = worktreeFixture("e2e-brief");
    const handler = createProductionStageHandler({
      env: handlerEnv(),
      worktrees,
      codingAgent: codingAgent(calls),
    });
    await processStageJob(
      {
        taskId: "e2e-brief",
        sessionId: "e2e-brief",
        stage: "plan",
        title: "Open a PR",
        description: "marker only",
      },
      { cursors: new InMemoryStepCursorStore(), handler, worktrees },
    );
    expect(calls[0]?.prompt).toContain("Title: Open a PR");
  });
});

describe("intake PR e2e script", () => {
  it("stays skippable and refuses task ids outside the e2e- prefix", () => {
    const script = readFileSync("scripts/intake-pr-e2e.sh", "utf8");
    expect(script).toContain("INTAKE_PR_E2E:-0");
    expect(script).toContain("e2e-[a-z0-9-]+");
    expect(script).toContain("secrets.sh run");
    expect(script).not.toContain("ghp_");
    expect(script).not.toContain("sk-");
  });
});
