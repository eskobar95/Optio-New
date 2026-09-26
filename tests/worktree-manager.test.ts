import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  InMemoryStepCursorStore,
  WorktreeIsolationError,
  WorktreeManager,
  createWorktreeStageHandler,
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
  await mkdir(path.join(repoPath, "src"), { recursive: true });
  await writeFile(path.join(repoPath, ".cursor", "skills", "secret.md"), "secret\n");
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

    await runPipeline(
      { taskId: "t-1", sessionId: "s-1" },
      {
        cursors: new InMemoryStepCursorStore(),
        worktrees,
        handler: {
          async run(ctx) {
            log.push(`${ctx.stage}:${ctx.step}`);
          },
        },
      },
    );

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
});
