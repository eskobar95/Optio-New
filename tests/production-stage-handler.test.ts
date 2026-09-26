import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CodingAgent, CodingAgentInput } from "../src/adapters/coding-agent.js";
import type { FlowJob } from "bullmq";
import {
  ApprovalRequiredError,
  InMemoryHitlStore,
  InMemoryStepCursorStore,
  PrSafetyClosedError,
  StageCredentialsError,
  applyHitlDecision,
  createProductionStageHandler,
  enqueueIntakePipeline,
  loadHitlConfig,
  processStageJob,
  runPipeline,
  type PrSafetyInput,
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
    if (method === "GET" && url.includes("/pulls?") && url.includes("state=open")) {
      return jsonResponse(200, []);
    }
    if (method === "POST" && url.endsWith("/pulls")) {
      return (
        extra?.onPost?.() ??
        jsonResponse(201, { html_url: "https://github.com/acme/widgets/pull/7", number: 7 })
      );
    }
    if (method === "GET" && url.includes("/commits/") && url.endsWith("/status")) {
      return jsonResponse(200, { state: "success" });
    }
    if (method === "GET" && url.includes("/check-runs")) {
      return jsonResponse(200, { total_count: 0, check_runs: [] });
    }
    if (method === "PUT" && url.endsWith("/merge")) {
      return jsonResponse(200, { merged: true });
    }
    return jsonResponse(500, { message: "unexpected" });
  };
  return { fetchImpl, calls };
}

function passingSafety(): Promise<PrSafetyInput> {
  return Promise.resolve({
    checks: {
      test: { exitCode: 0 },
      lint: { exitCode: 0 },
      typecheck: { exitCode: 0 },
    },
    diff: [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -0,0 +1 @@",
      "+export const ready = true;",
      "",
    ].join("\n"),
  });
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
    expect(calls[0]?.allowed_tools).toEqual(["read"]);
    expect(calls[0]?.permission_tier).toBe("read-only");
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
      loadPrSafety: passingSafety,
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
    expect(agentCalls.map((call) => call.permission_tier)).toEqual([
      "read-only",
      "edit-worktree",
      "read-only",
    ]);
    expect(agentCalls[1]?.allowed_tools).toEqual(["shell", "edit", "write"]);
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

  it("opens the pull request on the catalog repo for repoId", async () => {
    const taskId = "ship-fja";
    const { handle, worktrees } = worktreeFixture(taskId, true);
    const git = gitRunner({ ahead: "1" });
    const calls: { url: string; method: string; body?: string }[] = [];
    const repos = JSON.stringify([
      {
        repoId: "optio-new",
        cloneUrl: "https://github.com/eskobar95/Optio-New.git",
        localPath: "/opt/optio-new",
        defaultBranch: "development",
        worktreeRoot: "/wt/optio-new",
      },
      {
        repoId: "findjobabroad",
        cloneUrl: "https://github.com/kit/find-job-abroad.git",
        localPath: "/opt/findjobabroad",
        defaultBranch: "main",
        worktreeRoot: "/wt/fja",
      },
    ]);
    const handler = createProductionStageHandler({
      env: handlerEnv({
        OPTIO_NEW_GITHUB_REPO: "eskobar95/Optio-New",
        OPTIO_NEW_REPOS: repos,
        OPTIO_NEW_DEFAULT_REPO_ID: "optio-new",
      }),
      worktrees,
      git: git.git,
      loadPrSafety: passingSafety,
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({
          url,
          method,
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        if (method === "GET" && url.includes("/pulls?")) return jsonResponse(200, []);
        if (method === "POST" && url.endsWith("/pulls")) {
          return jsonResponse(201, {
            html_url: "https://github.com/kit/find-job-abroad/pull/4",
            number: 4,
          });
        }
        if (method === "GET" && url.includes("/check-runs")) {
          return jsonResponse(200, { total_count: 0, check_runs: [] });
        }
        if (method === "GET" && url.includes("/status"))
          return jsonResponse(200, { state: "success" });
        if (method === "PUT" && url.endsWith("/merge")) return jsonResponse(200, { merged: true });
        return jsonResponse(500, { message: "unexpected" });
      },
    });
    await handler.run({
      ...step("ready", "open_pr", taskId),
      repoId: "findjobabroad",
      title: "FJA",
    });
    const post = calls.find((call) => call.method === "POST");
    expect(post?.url).toBe("https://api.github.com/repos/kit/find-job-abroad/pulls");
    expect(JSON.parse(post?.body ?? "{}")).toMatchObject({ base: "main", head: handle.branch });
    expect(calls.some((call) => call.url.includes("Optio-New"))).toBe(false);
    const push = git.calls.find((call) => call.startsWith("push "));
    expect(push).toContain("github.com/kit/find-job-abroad.git");
    expect(push).not.toContain("Optio-New");

    calls.length = 0;
    await handler.run({ ...step("ready", "record_ci_wait", taskId), repoId: "findjobabroad" });
    expect(calls.some((call) => call.url.includes("/repos/kit/find-job-abroad/commits/"))).toBe(
      true,
    );
    expect(calls.some((call) => call.url.includes("Optio-New"))).toBe(false);

    calls.length = 0;
    await handler.run({ ...step("merge", "merge_branch", taskId), repoId: "findjobabroad" });
    expect(
      calls.some(
        (call) =>
          call.method === "PUT" && call.url.includes("/repos/kit/find-job-abroad/pulls/4/merge"),
      ),
    ).toBe(true);
    expect(calls.some((call) => call.url.includes("Optio-New"))).toBe(false);
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
      loadPrSafety: passingSafety,
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
      loadPrSafety: passingSafety,
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
      loadPrSafety: passingSafety,
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
      loadPrSafety: passingSafety,
    });
    await expect(handler.run(step("ready", "open_pr", taskId))).rejects.toBeInstanceOf(
      StageCredentialsError,
    );
  });

  it("re-running open_pr after the pull request record exists does not open another", async () => {
    const taskId = "ship-replay";
    const { worktrees } = worktreeFixture(taskId, true);
    const git = gitRunner({ ahead: "1" });
    const github = githubFetch();
    const handler = createProductionStageHandler({
      env: handlerEnv(),
      worktrees,
      git: git.git,
      fetchImpl: github.fetchImpl,
      loadPrSafety: passingSafety,
    });
    await handler.run(step("ready", "open_pr", taskId));
    const posts = github.calls.filter((call) => call.method === "POST").length;
    const pushes = git.calls.filter((call) => call.startsWith("push ")).length;
    expect(posts).toBe(1);
    expect(pushes).toBe(1);
    github.calls.length = 0;
    git.calls.length = 0;
    await handler.run(step("ready", "open_pr", taskId));
    expect(github.calls.filter((call) => call.method === "POST")).toEqual([]);
    expect(git.calls.filter((call) => call.startsWith("push "))).toEqual([]);
  });

  it("adopts an existing GitHub pull request instead of posting a second one", async () => {
    const taskId = "ship-remote";
    const { handle, worktrees } = worktreeFixture(taskId, true);
    const git = gitRunner({ ahead: "1" });
    const calls: { url: string; method: string }[] = [];
    const handler = createProductionStageHandler({
      env: handlerEnv(),
      worktrees,
      git: git.git,
      loadPrSafety: passingSafety,
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({ url, method });
        if (method === "GET" && url.includes("/pulls?")) {
          return jsonResponse(200, [
            {
              html_url: "https://github.com/acme/widgets/pull/9",
              number: 9,
              head: { ref: handle.branch },
            },
          ]);
        }
        if (method === "POST") return jsonResponse(500, { message: "should not post" });
        return jsonResponse(500, { message: "unexpected" });
      },
    });
    await handler.run(step("ready", "open_pr", taskId));
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    const again = githubFetch();
    const second = createProductionStageHandler({
      env: handlerEnv(),
      worktrees,
      git: git.git,
      fetchImpl: again.fetchImpl,
      loadPrSafety: passingSafety,
    });
    await second.run(step("ready", "open_pr", taskId));
    expect(again.calls.filter((call) => call.method === "POST")).toEqual([]);
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

  it("does not push when lint fails or the diff contains a secret", async () => {
    const taskId = "ship-risk";
    const { worktrees } = worktreeFixture(taskId, true);
    const git = gitRunner({ ahead: "1" });
    const github = githubFetch();
    const secret = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const handler = createProductionStageHandler({
      env: handlerEnv(),
      worktrees,
      git: git.git,
      fetchImpl: github.fetchImpl,
      loadPrSafety: async () => ({
        checks: {
          test: { exitCode: 0 },
          lint: { exitCode: 1 },
          typecheck: { exitCode: 0 },
        },
        diff: [
          "diff --git a/.env b/.env",
          "--- /dev/null",
          "+++ b/.env",
          "@@ -0,0 +1 @@",
          `+AWS_ACCESS_KEY_ID=${secret}`,
          "",
        ].join("\n"),
      }),
    });
    await expect(handler.run(step("ready", "open_pr", taskId))).rejects.toBeInstanceOf(
      PrSafetyClosedError,
    );
    await expect(handler.run(step("ready", "open_pr", taskId))).rejects.toThrow(
      /pr safety gate closed: secret_in_diff/,
    );
    expect(git.calls.some((call) => call.startsWith("push "))).toBe(false);
    expect(github.calls).toEqual([]);
    expect(git.calls.join("\n")).not.toContain(secret);
  });

  it("does not merge when the diff review finds a destructive path", async () => {
    const taskId = "ship-wipe";
    const { worktrees } = worktreeFixture(taskId, true);
    const git = gitRunner({ ahead: "1" });
    const github = githubFetch();
    const wipe = ["rm ", "-rf /tmp/proj"].join("");
    const handler = createProductionStageHandler({
      env: handlerEnv(),
      worktrees,
      git: git.git,
      fetchImpl: github.fetchImpl,
      loadPrSafety: async () => ({
        checks: {
          test: { exitCode: 0 },
          lint: { exitCode: 0 },
          typecheck: { exitCode: 0 },
        },
        diff: [
          "diff --git a/scripts/wipe.sh b/scripts/wipe.sh",
          "--- /dev/null",
          "+++ b/scripts/wipe.sh",
          "@@ -0,0 +1 @@",
          `+${wipe}`,
          "",
        ].join("\n"),
      }),
    });
    await expect(handler.run(step("merge", "merge_branch", taskId))).rejects.toThrow(
      /pr safety gate closed: destructive_path/,
    );
    expect(github.calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("does not push when typecheck was not run", async () => {
    const taskId = "ship-unchecked";
    const { worktrees } = worktreeFixture(taskId, true);
    const git = gitRunner({ ahead: "1" });
    const handler = createProductionStageHandler({
      env: handlerEnv(),
      worktrees,
      git: git.git,
      fetchImpl: githubFetch().fetchImpl,
      loadPrSafety: async () => ({
        checks: { test: { exitCode: 0 }, lint: { exitCode: 0 } },
        diff: "",
      }),
    });
    await expect(handler.run(step("ready", "open_pr", taskId))).rejects.toThrow(
      /typecheck_not_run/,
    );
    expect(git.calls.some((call) => call.startsWith("push "))).toBe(false);
  });

  it("sends Review feedback back to In Progress and retries the fix without drafting", async () => {
    const taskId = "lin-FIN-12";
    const { handle, worktrees } = worktreeFixture(taskId, true);
    mkdirSync(join(handle.path, "..", ".prs"), { recursive: true });
    writeFileSync(
      join(handle.path, "..", ".prs", `${taskId}.json`),
      `${JSON.stringify({
        url: "https://github.com/acme/widgets/pull/7",
        number: 7,
        head: handle.branch,
        base: "main",
      })}\n`,
    );
    const agentCalls: CodingAgentInput[] = [];
    let head = "aaa111";
    let ciState = "failure";
    const githubBodies: { url: string; method: string; body?: string }[] = [];
    const handler = createProductionStageHandler({
      env: handlerEnv({ OPTIO_NEW_LINEAR_API_KEY: "lin_api_testkey12345678" }),
      worktrees,
      codingAgent: codingAgent(agentCalls),
      git: async (_cwd, args) => {
        const command = args[0] === "-c" ? "commit" : args[0];
        if (command === "rev-parse") return head;
        if (command === "status") return head === "aaa111" ? " M src/app.ts" : "";
        if (command === "add") return "";
        if (command === "commit") {
          head = "bbb222";
          return "";
        }
        if (command === "push") return "";
        throw new Error(`unexpected git ${args.join(" ")}`);
      },
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? init.body : undefined;
        githubBodies.push({ url, method, body });
        if (url.includes("api.linear.app/graphql")) {
          const query = body ? ((JSON.parse(body) as { query?: string }).query ?? "") : "";
          if (query.includes("IssueStates")) {
            return jsonResponse(200, {
              data: {
                issue: {
                  team: {
                    states: {
                      nodes: [
                        { id: "s-ip", name: "In Progress" },
                        { id: "s-re", name: "Review" },
                        { id: "s-nh", name: "Needs Human" },
                      ],
                    },
                  },
                },
              },
            });
          }
          return jsonResponse(200, {
            data: { commentCreate: { success: true }, issueUpdate: { success: true } },
          });
        }
        if (method === "GET" && url.includes("/check-runs")) {
          return jsonResponse(200, { total_count: 0, check_runs: [] });
        }
        if (method === "GET" && url.endsWith("/status"))
          return jsonResponse(200, { state: ciState });
        if (method === "GET" && url.endsWith("/reviews")) {
          return jsonResponse(
            200,
            ciState === "success"
              ? []
              : [{ user: { login: "ada" }, state: "CHANGES_REQUESTED", body: "Fix the parser" }],
          );
        }
        if (method === "POST" && url.endsWith("/requested_reviewers")) {
          return jsonResponse(201, { requested_reviewers: [{ login: "ada" }] });
        }
        if (method === "POST" && url.endsWith("/reviews")) {
          return jsonResponse(201, { id: 3, state: "COMMENTED" });
        }
        if (method === "POST" && url.endsWith("/comments")) return jsonResponse(201, { id: 1 });
        if (method === "PATCH") return jsonResponse(200, { draft: false });
        return jsonResponse(500, { message: `unexpected ${method} ${url}` });
      },
    });
    const ctx = {
      ...step("ready", "record_ci_wait", taskId),
      source: "linear" as const,
      linearIssueId: "2174add1-f7c8-44e3-bbf3-2d60b5ea8bc9",
    };
    await expect(handler.run(ctx)).rejects.toThrow(/return_to_progress/);
    expect(agentCalls[0]?.prompt).toContain("Fix the parser");
    expect(agentCalls[0]?.prompt).toContain("Attempt: 1/3");
    expect(existsSync(join(handle.path, "linear-review-feedback.md"))).toBe(true);
    const feedback = readFileSync(join(handle.path, "linear-review-feedback.md"), "utf8");
    expect(feedback).toContain("Failed:");
    expect(feedback).toContain("Must fix:");
    const linearNotes = githubBodies
      .filter((call) => call.url.includes("api.linear.app"))
      .map((call) => call.body ?? "");
    expect(
      linearNotes.some((body) => body.includes("[ci]") && body.includes("Phase: started")),
    ).toBe(true);
    expect(linearNotes.some((body) => body.includes("Result: red"))).toBe(true);
    expect(linearNotes.some((body) => body.includes("[review]"))).toBe(true);
    expect(linearNotes.some((body) => body.includes("[status]"))).toBe(true);
    expect(githubBodies.some((call) => call.url.endsWith("/requested_reviewers"))).toBe(true);
    expect(
      githubBodies.some(
        (call) =>
          call.method === "POST" &&
          call.url.endsWith("/reviews") &&
          call.body?.includes('"event":"COMMENT"'),
      ),
    ).toBe(true);
    expect(
      githubBodies.some((call) => call.method === "POST" && call.url.endsWith("/comments")),
    ).toBe(true);
    expect(githubBodies.some((call) => call.body?.includes('"draft":true'))).toBe(false);
    expect(githubBodies.some((call) => call.method === "PATCH")).toBe(false);

    const progress = JSON.parse(
      readFileSync(join(handle.path, "..", ".prs", `${taskId}.linear.json`), "utf8"),
    ) as { ciFailureCount: number };
    expect(progress.ciFailureCount).toBe(1);
    expect(head).toBe("bbb222");

    ciState = "success";
    githubBodies.length = 0;
    await handler.run(ctx);
    expect(
      githubBodies.some((call) => call.method === "PATCH" && call.body?.includes('"draft":false')),
    ).toBe(true);
    const reviewUpdate = githubBodies.find(
      (call) => call.url.includes("api.linear.app") && call.body?.includes("s-re"),
    );
    expect(reviewUpdate).toBeTruthy();
  });

  it("moves a Linear issue to Review on green CI before merge approval", async () => {
    const taskId = "lin-ENG-9";
    const issueId = "2174add1-f7c8-44e3-bbf3-2d60b5ea8bc9";
    const { worktrees } = worktreeFixture(taskId, true);
    const git = gitRunner({ ahead: "1" });
    const calls: { url: string; method: string; body?: string }[] = [];
    const handler = createProductionStageHandler({
      env: handlerEnv({ OPTIO_NEW_LINEAR_API_KEY: "lin_api_testkey12345678" }),
      worktrees,
      git: git.git,
      loadPrSafety: passingSafety,
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? init.body : undefined;
        calls.push({ url, method, body });
        if (url.includes("api.linear.app/graphql")) {
          const query = body ? ((JSON.parse(body) as { query?: string }).query ?? "") : "";
          if (query.includes("IssueStates")) {
            return jsonResponse(200, {
              data: {
                issue: {
                  team: {
                    states: {
                      nodes: [
                        { id: "s-ip", name: "In Progress" },
                        { id: "s-re", name: "Review" },
                        { id: "s-me", name: "Merge" },
                        { id: "s-do", name: "Done" },
                      ],
                    },
                  },
                },
              },
            });
          }
          return jsonResponse(200, {
            data: { commentCreate: { success: true }, issueUpdate: { success: true } },
          });
        }
        if (method === "GET" && url.includes("/pulls?")) return jsonResponse(200, []);
        if (method === "POST" && url.endsWith("/pulls")) {
          return jsonResponse(201, {
            html_url: "https://github.com/acme/widgets/pull/66",
            number: 66,
          });
        }
        if (method === "GET" && url.includes("/check-runs")) {
          return jsonResponse(200, { total_count: 0, check_runs: [] });
        }
        if (method === "GET" && url.endsWith("/status")) {
          return jsonResponse(200, { state: "success", statuses: [] });
        }
        if (method === "GET" && url.endsWith("/reviews")) {
          return jsonResponse(200, [{ user: { login: "ada" }, state: "APPROVED", body: "" }]);
        }
        if (method === "PATCH") return jsonResponse(200, { draft: false });
        if (method === "PUT" && url.endsWith("/merge")) return jsonResponse(200, { merged: true });
        return jsonResponse(500, { message: `unexpected ${method} ${url}` });
      },
    });
    const cursors = new InMemoryStepCursorStore();
    const hitlState = new InMemoryHitlStore();
    const hitl = {
      config: loadHitlConfig({ OPTIO_HITL_MERGE: "always" }),
      store: hitlState,
      signals: hitlState,
    };
    const now = "2026-09-26T12:00:00.000Z";
    await cursors.save({
      taskId,
      sessionId: taskId,
      stage: "review",
      nextStepIndex: 2,
      status: "completed",
      updatedAt: now,
    });
    const payload = {
      taskId,
      sessionId: taskId,
      source: "linear" as const,
      linearIssueId: issueId,
      title: "Board status",
    };
    const ready = await processStageJob({ ...payload, stage: "ready" }, { cursors, handler, hitl });
    expect(ready.status).toBe("completed");
    const linearBodies = calls
      .filter((call) => call.url.includes("api.linear.app"))
      .map((call) => call.body ?? "");
    expect(linearBodies.some((body) => body.includes("[status]") && body.includes("Review"))).toBe(
      true,
    );
    expect(
      linearBodies.some((body) => body.includes("[ci]") && body.includes("Result: green")),
    ).toBe(true);
    expect(linearBodies.some((body) => body.includes("s-re"))).toBe(true);
    expect(linearBodies.some((body) => body.includes("s-me"))).toBe(false);
    expect(
      calls.some((call) => call.method === "PATCH" && call.body?.includes('"draft":false')),
    ).toBe(true);
    expect(calls.some((call) => call.method === "PUT" && call.url.endsWith("/merge"))).toBe(false);
    expect(await hitlState.get(taskId, taskId, "merge")).toBeUndefined();

    await expect(
      processStageJob({ ...payload, stage: "merge" }, { cursors, handler, hitl }),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
    const beforeApprove = calls
      .filter((call) => call.url.includes("api.linear.app"))
      .map((call) => call.body ?? "");
    expect(calls.some((call) => call.method === "PUT" && call.url.endsWith("/merge"))).toBe(false);
    expect(beforeApprove.some((body) => body.includes("s-me"))).toBe(false);

    await applyHitlDecision(
      { taskId, sessionId: taskId, point: "merge", action: "approve" },
      hitl,
      cursors,
    );
    const merged = await processStageJob(
      { ...payload, stage: "merge" },
      { cursors, handler, hitl },
    );
    expect(merged.status).toBe("completed");
    expect(calls.some((call) => call.method === "PUT" && call.url.endsWith("/merge"))).toBe(true);
    const afterMerge = calls
      .filter((call) => call.url.includes("api.linear.app"))
      .map((call) => call.body ?? "");
    expect(afterMerge.some((body) => body.includes("s-me"))).toBe(true);
    expect(afterMerge.some((body) => body.includes("s-do"))).toBe(true);
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
