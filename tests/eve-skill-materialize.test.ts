import { lstat, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { implementationAgent } from "../agents/implementation/agent.js";
import { createSkillStageHook, createWorkflowSkillLoader } from "../src/index.js";

const repoRoot = process.cwd();
const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Eve worktree skill seed", () => {
  it("materializes only the allow-list into .agents/skills when the worktree is created", async () => {
    const worktreePath = await mkdtemp(path.join(tmpdir(), "optio-eve-wt-"));
    cleanups.push(worktreePath);
    const hook = createSkillStageHook(createWorkflowSkillLoader({ repoRoot }));

    await hook.onCreate({
      taskId: "t-eve-5",
      worktreePath,
      stepId: implementationAgent.phase,
      plannerSelection: ["skills/tdd"],
    });

    const link = path.join(worktreePath, ".agents", "skills", "tdd");
    const stat = await lstat(link);
    expect(stat.isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(path.resolve(repoRoot, ".cursor", "skills", "tdd"));
    expect(await readFile(path.join(link, "SKILL.md"), "utf8")).toContain("name: tdd");
    await expect(
      lstat(path.join(worktreePath, ".agents", "skills", "code-review")),
    ).rejects.toThrow();
    await expect(lstat(path.join(worktreePath, ".cursor"))).rejects.toThrow();
  });

  it("reaps .agents/skills on worktree delete and leaves the control-plane skill in place", async () => {
    const worktreePath = await mkdtemp(path.join(tmpdir(), "optio-eve-wt-"));
    cleanups.push(worktreePath);
    const hook = createSkillStageHook(createWorkflowSkillLoader({ repoRoot }));
    await hook.onCreate({
      taskId: "t-eve-5",
      worktreePath,
      stepId: implementationAgent.phase,
      plannerSelection: ["skills/tdd"],
    });
    await writeFile(path.join(worktreePath, ".agents", "notes.txt"), "keep\n");

    await hook.onDelete({ taskId: "t-eve-5", worktreePath });

    await expect(lstat(path.join(worktreePath, ".agents", "skills"))).rejects.toThrow();
    await expect(readFile(path.join(worktreePath, ".agents", "notes.txt"), "utf8")).resolves.toBe(
      "keep\n",
    );
    await expect(
      readFile(path.join(repoRoot, ".cursor", "skills", "tdd", "SKILL.md"), "utf8"),
    ).resolves.toContain("name: tdd");
  });
});
