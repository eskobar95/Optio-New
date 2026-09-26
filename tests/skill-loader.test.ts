import { execFile } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SkillBudgetDeniedError,
  WorktreeManager,
  createSkillStageHook,
  createWorkflowSkillLoader,
  createWorktreeStageHandler,
  runAgentLoop,
  type AuditSink,
  type DecisionSidecar,
  type ModelAdapter,
} from "../src/index.js";

const execFileAsync = promisify(execFile);
const cleanups: string[] = [];
const repoRoot = process.cwd();

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

describe("workflow SkillLoader allow-list", () => {
  const loader = createWorkflowSkillLoader({ repoRoot });

  it("uses the step list for an explicit budget and ignores a foreign planner selection", async () => {
    await expect(loader.computeAllowList({ stepId: "planner" })).resolves.toEqual([
      "skills/_shared",
      "skills/bot-session",
    ]);
    await expect(
      loader.computeAllowList({
        stepId: "review",
        plannerSelection: ["skills/tdd", "skills/code-review"],
      }),
    ).resolves.toEqual(["skills/code-review"]);
    await expect(loader.computeAllowList({ stepId: "merge" })).resolves.toEqual([
      "skills/land",
      "skills/reap-worktree",
    ]);
  });

  it("intersects from_planner_selection with the global index and drops unknown ids", async () => {
    await expect(
      loader.computeAllowList({
        stepId: "implementation",
        plannerSelection: ["skills/tdd", "skills/not-indexed", "skills/tdd", "skills/bot-session"],
      }),
    ).resolves.toEqual(["skills/tdd", "skills/bot-session"]);
    await expect(loader.computeAllowList({ stepId: "implementation" })).resolves.toEqual([]);
  });

  it("drops explicit step skills that are not in the global index", async () => {
    const root = await tempDir("optio-skills-");
    await mkdir(path.join(root, "workflows"), { recursive: true });
    await mkdir(path.join(root, "skills"), { recursive: true });
    await writeFile(
      path.join(root, "workflows", "default-task.yaml"),
      [
        "name: fixture",
        "steps:",
        "  - id: review",
        "    skills_allowed: [skills/code-review, skills/not-indexed]",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(root, "skills", "index.json"),
      JSON.stringify({
        skills: [
          {
            id: "skills/code-review",
            cursor_native_id: "code-review",
            cursor_native_path: ".cursor/skills/code-review",
          },
        ],
      }),
    );

    const fixture = createWorkflowSkillLoader({ repoRoot: root });
    await expect(fixture.computeAllowList({ stepId: "review" })).resolves.toEqual([
      "skills/code-review",
    ]);
    await expect(fixture.computeAllowList({ stepId: "missing" })).rejects.toThrow(
      /unknown workflow step missing/,
    );
  });
});

describe("workflow SkillLoader materialize and load_skill", () => {
  const loader = createWorkflowSkillLoader({ repoRoot });

  it("seeds only the allow-list as symlinks to the control-plane SoT and reap removes that directory", async () => {
    const worktree = await tempDir("optio-seed-");
    const extra = path.join(worktree, ".agents", "skills", "not-allowed");
    await mkdir(extra, { recursive: true });
    await writeFile(path.join(extra, "SKILL.md"), "do not keep\n");
    await writeFile(path.join(worktree, ".agents", "keep.txt"), "keep\n");

    await loader.seed(worktree, ["skills/tdd", "skills/bot-session"]);

    const names = await readdir(path.join(worktree, ".agents", "skills"));
    expect(names.sort()).toEqual(["bot-session", "tdd"]);
    const link = await readlink(path.join(worktree, ".agents", "skills", "tdd"));
    expect(path.resolve(link)).toBe(path.resolve(repoRoot, ".cursor", "skills", "tdd"));
    const stat = await lstat(path.join(worktree, ".agents", "skills", "tdd"));
    expect(stat.isSymbolicLink()).toBe(true);
    await expect(access(extra)).rejects.toThrow();

    await loader.reap(worktree);
    await expect(access(path.join(worktree, ".agents", "skills"))).rejects.toThrow();
    await expect(readFile(path.join(worktree, ".agents", "keep.txt"), "utf8")).resolves.toBe(
      "keep\n",
    );
  });

  it("hard-denies load_skill outside the budget before reading a body", async () => {
    await expect(loader.loadSkill("skills/land", ["skills/bot-session"])).rejects.toBeInstanceOf(
      SkillBudgetDeniedError,
    );
    await expect(
      loader.loadSkill("skills/not-indexed", ["skills/not-indexed"]),
    ).rejects.toBeInstanceOf(SkillBudgetDeniedError);
    await expect(loader.loadSkill("skills/does-not-exist", [])).rejects.toBeInstanceOf(
      SkillBudgetDeniedError,
    );

    const loaded = await loader.loadSkill("skills/bot-session", ["skills/bot-session"]);
    expect(loaded.id).toBe("skills/bot-session");
    expect(loaded.sourcePath).toBe(path.resolve(repoRoot, ".cursor", "skills", "bot-session"));
    expect(loaded.body).toContain("name: bot-session");
    expect(loaded.body).toContain("No Linear API");
  });
});

describe("agent loop load_skill gate", () => {
  it("denies load_skill outside the budget and loads an allowed skill without the caller executor", async () => {
    const execute = vi.fn(async () => "caller-ran");
    const audit: AuditSink = { record: vi.fn() };
    const sidecar: DecisionSidecar = {
      advise: vi.fn(async () => ({ verdict: "allow" as const, reason: "sidecar says allow" })),
    };
    const adapter: ModelAdapter = {
      async complete() {
        return {
          text: "ack",
          toolCalls: [
            { tool: "load_skill", action: "read", skillId: "skills/land" },
            { tool: "load_skill", action: "read", skillId: "skills/bot-session" },
          ],
        };
      },
    };

    const result = await runAgentLoop(
      {
        prompt: "load skills",
        activeSkillBudget: ["skills/bot-session"],
        tools: { execute, audit, sidecar },
      },
      adapter,
      {
        async resolve() {
          return [];
        },
      },
    );

    expect(result.toolResults?.[0]).toMatchObject({
      status: "denied",
      decision: {
        verdict: "deny",
        gate: "skill_budget",
        reason: "load_skill denied: outside the active skill budget",
      },
    });
    expect(result.toolResults?.[1]?.status).toBe("allowed");
    expect(result.toolResults?.[1]).toMatchObject({
      status: "allowed",
      value: expect.objectContaining({ id: "skills/bot-session" }),
    });
    const allowed = result.toolResults?.[1];
    if (allowed?.status === "allowed") {
      expect(String(JSON.stringify(allowed.value))).toContain("name: bot-session");
      expect(String(JSON.stringify(allowed.value))).not.toContain("do not keep");
    }
    expect(execute).not.toHaveBeenCalled();
    expect(sidecar.advise).toHaveBeenCalledTimes(1);
  });
});

describe("worktree skill seed and reap", () => {
  it("create seeds only allowed skills and delete reaps .agents/skills before removing the worktree", async () => {
    const dir = await tempDir("optio-wt-skills-");
    const repoPath = path.join(dir, "repo");
    const root = path.join(dir, "worktrees");
    await git(dir, ["init", "-b", "development", repoPath]);
    await git(repoPath, ["config", "user.email", "optio-new@example.com"]);
    await git(repoPath, ["config", "user.name", "Optio New"]);
    await git(repoPath, ["config", "commit.gpgsign", "false"]);
    const planted = path.join(repoPath, ".agents", "skills", "not-allowed");
    await mkdir(planted, { recursive: true });
    await writeFile(path.join(planted, "SKILL.md"), "planted\n");
    await mkdir(path.join(repoPath, "src"), { recursive: true });
    await writeFile(path.join(repoPath, "src", "keep.txt"), "keep\n");
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-m", "init"]);

    const loader = createWorkflowSkillLoader({ repoRoot });
    const events: string[] = [];
    const inner = createSkillStageHook(loader);
    const manager = new WorktreeManager({
      root,
      repoPath,
      baseBranch: "development",
      skillStageHook: {
        async onCreate(ctx) {
          events.push("create");
          await inner.onCreate(ctx);
        },
        async onDelete(ctx) {
          events.push(`delete-while-present:${await pathExists(ctx.worktreePath)}`);
          await inner.onDelete(ctx);
          events.push(
            `skills-gone:${!(await pathExists(path.join(ctx.worktreePath, ".agents", "skills")))}`,
          );
        },
      },
    });

    const handle = await manager.create("task-skills", {
      stepId: "implementation",
      plannerSelection: ["skills/tdd", "skills/not-indexed"],
    });

    const names = await readdir(path.join(handle.path, ".agents", "skills"));
    expect(names).toEqual(["tdd"]);
    const link = await readlink(path.join(handle.path, ".agents", "skills", "tdd"));
    expect(path.resolve(link)).toBe(path.resolve(repoRoot, ".cursor", "skills", "tdd"));
    await expect(
      access(path.join(handle.path, ".agents", "skills", "not-allowed")),
    ).rejects.toThrow();
    await expect(readFile(path.join(handle.path, "src", "keep.txt"), "utf8")).resolves.toBe(
      "keep\n",
    );

    const retained = await manager.reap("task-skills", { merged: false });
    expect(retained.action).toBe("retained");
    await expect(
      access(path.join(handle.path, ".agents", "skills", "tdd")),
    ).resolves.toBeUndefined();

    await expect(manager.reap("task-skills", { merged: true })).resolves.toMatchObject({
      action: "reaped",
    });
    await expect(access(handle.path)).rejects.toThrow();
    expect(events).toEqual(["create", "delete-while-present:true", "skills-gone:true"]);
  });

  it("forwards the workflow step and planner selection from the implement stage hook", async () => {
    const seen: unknown[] = [];
    const worktrees = {
      async create(
        taskId: string,
        options?: { stepId?: string; plannerSelection?: readonly string[] },
      ) {
        seen.push({ taskId, options });
        return {
          taskId,
          worktreeId: `wt-${taskId}`,
          path: `/tmp/${taskId}`,
          branch: `task/${taskId}`,
        };
      },
      async reap(taskId: string, outcome: { merged: boolean }) {
        return {
          taskId,
          action: outcome.merged ? ("reaped" as const) : ("retained" as const),
          path: `/tmp/${taskId}`,
          reason: outcome.merged ? ("merged" as const) : ("failure" as const),
        };
      },
    };
    const handler = createWorktreeStageHandler(worktrees, {
      async run() {
        return undefined;
      },
    });

    await handler.run({
      taskId: "t-9",
      stage: "implement",
      step: "invoke_implementation",
      workflowStepId: "implementation",
      plannerSelection: ["skills/tdd"],
    });

    expect(seen).toEqual([
      {
        taskId: "t-9",
        options: { stepId: "implementation", plannerSelection: ["skills/tdd"] },
      },
    ]);
  });
});

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
