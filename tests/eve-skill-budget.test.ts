import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { implementationAgent } from "../agents/implementation/agent.js";
import { EveSkillLoader, SkillBudgetDeniedError, parseSkillIndex } from "../src/index.js";

const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "eve");
const sourceRoot = path.join(fixtureRoot, "control-plane");

interface BudgetFixture {
  plannerSelection: string[];
}

async function loadFixture(): Promise<{
  loader: EveSkillLoader;
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
  const loader = new EveSkillLoader({
    sourceRoot,
    index: parseSkillIndex(indexDocument),
    globalAllowList: implementationAgent.skills.allowed,
  });
  return { loader, budget };
}

describe("Eve skill budget", () => {
  it("denies load_skill when the id is outside the allow-list", async () => {
    const { loader, budget } = await loadFixture();
    expect(implementationAgent.skills.mode).toBe("from_planner_selection");
    expect(implementationAgent.skills.allowed).toContain("skills/tdd");
    expect(implementationAgent.skills.allowed).not.toContain("skills/code-review");

    const allowList = loader.resolveAllowList({
      skillsAllowed: implementationAgent.skills.mode,
      plannerSelection: budget.plannerSelection,
    });

    expect(allowList).toEqual(["skills/tdd"]);

    await expect(loader.loadSkill("skills/code-review", allowList)).rejects.toBeInstanceOf(
      SkillBudgetDeniedError,
    );
    await expect(loader.loadSkill("skills/code-review", allowList)).rejects.toMatchObject({
      code: "skill_budget_denied",
      skillId: "skills/code-review",
    });
    await expect(loader.loadSkill("skills/not-indexed", ["skills/tdd"])).rejects.toMatchObject({
      code: "skill_budget_denied",
      skillId: "skills/not-indexed",
    });

    const loaded = await loader.loadSkill("skills/tdd", allowList);
    expect(loaded.id).toBe("skills/tdd");
    expect(loaded.body).toContain("eve-fixture-tdd-7c2a");
    expect(loaded.body).not.toContain("eve-fixture-review-91bd");
    expect(loaded.sourcePath).toBe(path.join(sourceRoot, ".cursor", "skills", "tdd", "SKILL.md"));
  });
});
