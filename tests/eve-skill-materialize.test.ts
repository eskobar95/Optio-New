import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { implementationAgent } from "../agents/implementation/agent.js";
import { EveSkillLoader, EveWorktreeSkillSeed, parseSkillIndex } from "../src/index.js";

const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "eve");
const sourceRoot = path.join(fixtureRoot, "control-plane");
const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface BudgetFixture {
  plannerSelection: string[];
}

async function seedFromFixture(): Promise<{
  worktreePath: string;
  seed: EveWorktreeSkillSeed;
  budget: BudgetFixture;
}> {
  const [indexDocument, budget] = await Promise.all([
    readFile(path.join(sourceRoot, "skills", "index.json"), "utf8").then(
      (raw) => JSON.parse(raw) as unknown,
    ),
    readFile(path.join(fixtureRoot, "implementation-budget.json"), "utf8").then(
      (raw) => JSON.parse(raw) as BudgetFixture,
    ),
  ]);
  const worktreePath = await mkdtemp(path.join(tmpdir(), "optio-eve-wt-"));
  cleanups.push(worktreePath);
  const loader = new EveSkillLoader({
    sourceRoot,
    index: parseSkillIndex(indexDocument),
    globalAllowList: implementationAgent.skills.allowed,
  });
  return { worktreePath, seed: new EveWorktreeSkillSeed(loader), budget };
}

describe("Eve worktree skill seed", () => {
  it("materializes only the allow-list into .agents/skills when the worktree is created", async () => {
    const { worktreePath, seed, budget } = await seedFromFixture();

    const seeded = await seed.onCreate({
      worktreePath,
      skillsAllowed: implementationAgent.skills.mode,
      plannerSelection: budget.plannerSelection,
    });

    expect(seeded.allowList).toEqual(["skills/tdd"]);

    const link = path.join(worktreePath, ".agents", "skills", "tdd");
    const stat = await lstat(link);
    expect(stat.isSymbolicLink()).toBe(true);
    expect(await realpath(link)).toBe(
      await realpath(path.join(sourceRoot, ".cursor", "skills", "tdd")),
    );
    expect(await readFile(path.join(link, "SKILL.md"), "utf8")).toContain("eve-fixture-tdd-7c2a");

    await expect(
      lstat(path.join(worktreePath, ".agents", "skills", "code-review")),
    ).rejects.toThrow();
    await expect(lstat(path.join(worktreePath, ".cursor"))).rejects.toThrow();
  });

  it("reaps .agents/skills on worktree delete and leaves the control-plane skill in place", async () => {
    const { worktreePath, seed, budget } = await seedFromFixture();
    await seed.onCreate({
      worktreePath,
      skillsAllowed: implementationAgent.skills.mode,
      plannerSelection: budget.plannerSelection,
    });
    await mkdir(path.join(worktreePath, ".agents"), { recursive: true });
    await writeFile(path.join(worktreePath, ".agents", "notes.txt"), "keep\n");

    await seed.onDelete(worktreePath);

    await expect(lstat(path.join(worktreePath, ".agents", "skills"))).rejects.toThrow();
    await expect(readFile(path.join(worktreePath, ".agents", "notes.txt"), "utf8")).resolves.toBe(
      "keep\n",
    );
    await expect(
      readFile(path.join(sourceRoot, ".cursor", "skills", "tdd", "SKILL.md"), "utf8"),
    ).resolves.toContain("eve-fixture-tdd-7c2a");
  });
});
