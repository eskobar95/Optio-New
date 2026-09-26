import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { CodingAgentInput } from "../src/adapters/coding-agent.js";
import {
  InMemoryStepCursorStore,
  WorktreeIsolationError,
  WorktreeManager,
  createProductionStageHandler,
  createStageTracer,
  createWorktreeStageHandler,
  loadWorktreeRuntimeConfig,
  processStageJob,
  runPipeline,
} from "../src/index.js";

const execFileAsync = promisify(execFile);
const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function initFixture(): Promise<{ repoPath: string; root: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "optio-wt-"));
  cleanups.push(dir);
  const repoPath = path.join(dir, "repo");
  const root = path.join(dir, "worktrees");
  await git(dir, ["init", "-b", "development", repoPath]);
  await git(repoPath, ["config", "user.email", "optio-new@example.com"]);
  await git(repoPath, ["config", "user.name", "Optio New"]);
  await git(repoPath, ["config", "commit.gpgsign", "false"]);
  await mkdir(path.join(repoPath, ".cursor", "skills"), { recursive: true });
  await mkdir(path.join(repoPath, ".cursor", "agents"), { recursive: true });
  await mkdir(path.join(repoPath, ".cursor", "commands"), { recursive: true });
  await mkdir(path.join(repoPath, ".cursor", "rules"), { recursive: true });
  await mkdir(path.join(repoPath, "src"), { recursive: true });
  await writeFile(path.join(repoPath, ".cursor", "skills", "secret.md"), "secret\n");
  await writeFile(path.join(repoPath, ".cursor", "agents", "backend.md"), "agent\n");
  await writeFile(path.join(repoPath, ".cursor", "commands", "implement.md"), "command\n");
  await writeFile(path.join(repoPath, ".cursor", "rules", "always.md"), "rule\n");
  await writeFile(path.join(repoPath, "src", "keep.txt"), "keep\n");
  await git(repoPath, ["add", "."]);
  await git(repoPath, ["commit", "-m", "init"]);
  return { repoPath, root };
}

describe("worktree manager", () => {
  it("create(taskId) returns a unique path under the configured root", async () => {
    const { repoPath, root } = await initFixture();
    const manager = new WorktreeManager({
      root,
      repoPath,
      baseBranch: "development",
    });

    const first = await manager.create("task-a");
    const second = await manager.create("task-b");
    const again = await manager.create("task-a");

    expect(first.path.startsWith(root + path.sep)).toBe(true);
    expect(second.path.startsWith(root + path.sep)).toBe(true);
    expect(first.path).not.toBe(second.path);
    expect(again.path).toBe(first.path);
    expect(first.branch).toBe("task/task-a");
    await expect(readFile(path.join(first.path, "src", "keep.txt"), "utf8")).resolves.toBe(
      "keep\n",
    );
    await expect(access(path.join(first.path, ".cursor", "skills", "secret.md"))).rejects.toThrow();
    await expect(
      access(path.join(first.path, ".cursor", "agents", "backend.md")),
    ).rejects.toThrow();
    await expect(
      access(path.join(first.path, ".cursor", "commands", "implement.md")),
    ).rejects.toThrow();
    await expect(access(path.join(first.path, ".cursor", "rules", "always.md"))).rejects.toThrow();
    await expect(manager.status("task-a")).resolves.toMatchObject({
      taskId: "task-a",
      path: first.path,
    });
  });

  it("two concurrent tasks cannot share a worktree", async () => {
    const { repoPath, root } = await initFixture();
    const left = new WorktreeManager({ root, repoPath, baseBranch: "development" });
    const right = new WorktreeManager({ root, repoPath, baseBranch: "development" });

    const [alpha, beta] = await Promise.all([left.create("alpha"), right.create("beta")]);

    expect(alpha.path).not.toBe(beta.path);
    expect(alpha.path.startsWith(root + path.sep)).toBe(true);
    expect(beta.path.startsWith(root + path.sep)).toBe(true);

    await Promise.all([
      left.writeFile("alpha", "agent.txt", "alpha"),
      right.writeFile("beta", "agent.txt", "beta"),
    ]);

    await expect(readFile(path.join(alpha.path, "agent.txt"), "utf8")).resolves.toBe("alpha");
    await expect(readFile(path.join(beta.path, "agent.txt"), "utf8")).resolves.toBe("beta");

    const escape = path.relative(alpha.path, path.join(beta.path, "agent.txt"));
    await expect(left.writeFile("alpha", escape, "stolen")).rejects.toBeInstanceOf(
      WorktreeIsolationError,
    );
    await expect(readFile(path.join(beta.path, "agent.txt"), "utf8")).resolves.toBe("beta");

    const settled = await Promise.allSettled([left.create("a/b"), right.create("a-b")]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((result) => result.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toBeInstanceOf(WorktreeIsolationError);
    }
  });

  it("reaps on merge success and retains on failure until configured otherwise", async () => {
    const { repoPath, root } = await initFixture();
    const manager = new WorktreeManager({
      root,
      repoPath,
      baseBranch: "development",
    });
    const merged = await manager.create("merged-task");
    const failed = await manager.create("failed-task");

    await expect(manager.reap("merged-task", { merged: true })).resolves.toMatchObject({
      action: "reaped",
      reason: "merged",
    });
    await expect(access(merged.path)).rejects.toThrow();
    await expect(
      git(repoPath, ["show-ref", "--verify", "--quiet", "refs/heads/task/merged-task"]),
    ).rejects.toThrow();

    await expect(manager.reap("failed-task", { merged: false })).resolves.toMatchObject({
      action: "retained",
      reason: "failure",
      path: failed.path,
    });
    await expect(access(failed.path)).resolves.toBeUndefined();

    const dropping = new WorktreeManager({
      root,
      repoPath,
      baseBranch: "development",
      retainOnFailure: false,
    });
    const gone = await dropping.create("drop-task");
    await expect(dropping.reap("drop-task", { merged: false })).resolves.toMatchObject({
      action: "reaped",
      reason: "failure",
    });
    await expect(access(gone.path)).rejects.toThrow();
  });

  it("adopts the same worktree when the lock file was lost before a retry", async () => {
    const { repoPath, root } = await initFixture();
    const manager = new WorktreeManager({
      root,
      repoPath,
      baseBranch: "development",
    });
    const first = await manager.create("task-a");
    await rm(path.join(root, ".locks", "task-a.json"));
    const again = await manager.create("task-a");
    expect(again.path).toBe(first.path);
    expect(again.branch).toBe(first.branch);
    const listed = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoPath,
    });
    const paths = listed.stdout
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length).trim());
    expect(paths.filter((entry) => entry === first.path)).toEqual([first.path]);
  });
});

describe("BullMQ worktree hooks", () => {
  it("creates on implement and reaps on merge cleanup, retaining when merge fails", async () => {
    const log: string[] = [];
    const worktrees = {
      async create(taskId: string) {
        log.push(`create:${taskId}`);
        return {
          taskId,
          worktreeId: `wt-${taskId}`,
          path: `/tmp/${taskId}`,
          branch: `task/${taskId}`,
        };
      },
      async reap(taskId: string, outcome: { merged: boolean }) {
        log.push(`reap:${taskId}:${outcome.merged}`);
        return {
          taskId,
          action: outcome.merged ? ("reaped" as const) : ("retained" as const),
          path: `/tmp/${taskId}`,
          reason: outcome.merged ? ("merged" as const) : ("failure" as const),
        };
      },
    };

    const seenIds: string[] = [];
    await runPipeline(
      { taskId: "t-1", sessionId: "s-1" },
      {
        cursors: new InMemoryStepCursorStore(),
        worktrees,
        handler: {
          async run(ctx) {
            log.push(`${ctx.stage}:${ctx.step}`);
            if (ctx.step === "invoke_implementation" && ctx.worktreeId)
              seenIds.push(ctx.worktreeId);
          },
        },
      },
    );

    expect(seenIds).toEqual(["wt-t-1"]);
    expect(log.indexOf("create:t-1")).toBe(log.indexOf("implement:invoke_implementation") - 1);
    expect(log.indexOf("reap:t-1:true")).toBe(log.indexOf("merge:record_cleanup") + 1);
    expect(log.filter((entry) => entry.startsWith("reap:"))).toEqual(["reap:t-1:true"]);

    const failureLog: string[] = [];
    const failingTrees = {
      async create(taskId: string) {
        failureLog.push(`create:${taskId}`);
        return worktrees.create(taskId);
      },
      async reap(taskId: string, outcome: { merged: boolean }) {
        failureLog.push(`reap:${taskId}:${outcome.merged}`);
        return worktrees.reap(taskId, outcome);
      },
    };
    const failing = createWorktreeStageHandler(failingTrees, {
      async run(ctx) {
        failureLog.push(`${ctx.stage}:${ctx.step}`);
        if (ctx.stage === "merge" && ctx.step === "merge_branch") {
          throw new Error("merge rejected");
        }
      },
    });
    await expect(
      failing.run({
        taskId: "t-2",
        stage: "merge",
        step: "merge_branch",
      }),
    ).rejects.toThrow(/merge rejected/);
    expect(failureLog).toEqual(["merge:merge_branch", "reap:t-2:false"]);
  });

  it("retries implement after a crash without adding a second worktree", async () => {
    const { repoPath, root } = await initFixture();
    const manager = new WorktreeManager({ root, repoPath, baseBranch: "development" });
    const cursors = new InMemoryStepCursorStore();
    const identity = { taskId: "t-1", sessionId: "s-1" };
    await processStageJob(
      { ...identity, stage: "plan" },
      { cursors, worktrees: manager, handler: { async run() {} } },
    );
    let crash = true;
    await expect(
      processStageJob(
        { ...identity, stage: "implement" },
        {
          cursors,
          worktrees: manager,
          handler: {
            async run(ctx) {
              if (crash && ctx.step === "invoke_implementation") {
                crash = false;
                throw new Error("implement crashed");
              }
            },
          },
        },
      ),
    ).rejects.toThrow(/implement crashed/);
    await processStageJob(
      { ...identity, stage: "implement" },
      { cursors, worktrees: manager, handler: { async run() {} } },
    );
    const listed = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoPath,
    });
    const matches = listed.stdout
      .split("\n")
      .filter((line) => line.startsWith("worktree ") && line.includes(`${path.sep}wt-t-1`));
    expect(matches).toHaveLength(1);
  });
});

describe("worktree runtime config", () => {
  it("reads OPTIO_NEW_WORKTREE_ROOT, repo path, and retain-on-failure", () => {
    expect(loadWorktreeRuntimeConfig({})).toEqual({
      root: "/var/lib/optio-new/worktrees",
      repoPath: "/opt/optio-new",
      baseBranch: "development",
      retainOnFailure: true,
    });
    expect(
      loadWorktreeRuntimeConfig({
        OPTIO_NEW_WORKTREE_ROOT: "/data/wt",
        OPTIO_NEW_REPO_PATH: "/data/repo",
        OPTIO_NEW_BASE_BRANCH: "origin/development",
        OPTIO_NEW_WORKTREE_RETAIN_ON_FAILURE: "false",
      }),
    ).toEqual({
      root: "/data/wt",
      repoPath: "/data/repo",
      baseBranch: "origin/development",
      retainOnFailure: false,
    });
    expect(() =>
      loadWorktreeRuntimeConfig({ OPTIO_NEW_WORKTREE_RETAIN_ON_FAILURE: "yes" }),
    ).toThrow(/true or false/);
  });
});

describe("implement stage isolation", () => {
  it("runs coding cwd in distinct worktrees and emits create and remove spans", async () => {
    const { repoPath, root } = await initFixture();
    const tracer = createStageTracer();
    const manager = new WorktreeManager({
      root,
      repoPath,
      baseBranch: "development",
      tracer,
    });
    const calls: CodingAgentInput[] = [];
    const handler = createProductionStageHandler({
      env: { CURSOR_API_KEY: "cursor-test" },
      worktrees: manager,
      codingAgent: {
        id: "cursor",
        async run(input) {
          calls.push(input);
          return { pr_ready: false, status: "succeeded", usage: { provider: "cursor" } };
        },
      },
    });
    const cursors = new InMemoryStepCursorStore();
    const updatedAt = "2026-09-26T12:00:00.000Z";
    for (const taskId of ["alpha", "beta"]) {
      await cursors.save({
        taskId,
        sessionId: taskId,
        stage: "plan",
        nextStepIndex: 2,
        status: "completed",
        updatedAt,
      });
    }

    await Promise.all(
      ["alpha", "beta"].map((taskId) =>
        processStageJob(
          { taskId, sessionId: taskId, stage: "implement" },
          { cursors, handler, worktrees: manager, tracer },
        ),
      ),
    );

    expect(calls).toHaveLength(2);
    const byTask = new Map(calls.map((call) => [call.metadata.task_id, call]));
    const alpha = byTask.get("alpha");
    const beta = byTask.get("beta");
    expect(alpha?.worktree_path).not.toBe(beta?.worktree_path);
    expect(alpha?.metadata.worktree_id).toBe("wt-alpha");
    expect(beta?.metadata.worktree_id).toBe("wt-beta");
    expect(alpha?.worktree_path.endsWith(`${path.sep}wt-alpha`)).toBe(true);
    expect(beta?.worktree_path.endsWith(`${path.sep}wt-beta`)).toBe(true);
    await expect(
      access(path.join(alpha?.worktree_path ?? "", ".cursor", "skills", "secret.md")),
    ).rejects.toThrow();

    const creates = tracer.finished().filter((span) => span.name === "worktree.create");
    expect(creates.map((span) => span.attributes.task_id).sort()).toEqual(["alpha", "beta"]);
    expect(creates.map((span) => span.attributes.worktree_id).sort()).toEqual([
      "wt-alpha",
      "wt-beta",
    ]);

    await manager.create("alpha");
    expect(tracer.finished().filter((span) => span.name === "worktree.create")).toHaveLength(2);

    await expect(manager.reap("alpha", { merged: false })).resolves.toMatchObject({
      action: "retained",
    });
    expect(tracer.finished().filter((span) => span.name === "worktree.remove")).toHaveLength(0);
    await expect(access(path.join(root, "wt-alpha"))).resolves.toBeUndefined();

    await expect(manager.reap("beta", { merged: true })).resolves.toMatchObject({
      action: "reaped",
      reason: "merged",
    });
    const removes = tracer.finished().filter((span) => span.name === "worktree.remove");
    expect(removes).toHaveLength(1);
    expect(removes[0]?.attributes.task_id).toBe("beta");
    expect(removes[0]?.attributes.worktree_id).toBe("wt-beta");
    await expect(access(path.join(root, "wt-beta"))).rejects.toThrow();

    const names = await readdir(root);
    expect(names.filter((name) => name.startsWith("wt-"))).toEqual(["wt-alpha"]);
    expect(names.every((name) => name === "wt-alpha" || name.startsWith("."))).toBe(true);
  });

  it("tags a later stage with the worktree id from status", async () => {
    const tracer = createStageTracer();
    const cursors = new InMemoryStepCursorStore();
    await cursors.save({
      taskId: "t-1",
      sessionId: "s-1",
      stage: "implement",
      nextStepIndex: 2,
      status: "completed",
      updatedAt: "2026-09-26T12:00:00.000Z",
    });
    await processStageJob(
      { taskId: "t-1", sessionId: "s-1", stage: "review" },
      {
        cursors,
        tracer,
        handler: { async run() {} },
        worktrees: {
          async create() {
            throw new Error("review must not create");
          },
          async reap() {
            throw new Error("review must not reap");
          },
          async status() {
            return {
              taskId: "t-1",
              worktreeId: "wt-t-1",
              path: "/tmp/wt-t-1",
              branch: "task/t-1",
            };
          },
        },
      },
    );
    const span = tracer.finished().find((item) => item.name === "workflow.step");
    expect(span?.attributes.task_id).toBe("t-1");
    expect(span?.attributes.worktree_id).toBe("wt-t-1");
  });
});
