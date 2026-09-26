import path from "node:path";
import { describe, expect, it } from "vitest";
import { implementationAgent } from "../agents/implementation/agent.js";
import { SkillBudgetDeniedError, createWorkflowSkillLoader } from "../src/index.js";

const repoRoot = process.cwd();

describe("Eve skill budget", () => {
  it("denies load_skill when the id is outside the implementation allow-list", async () => {
    expect(implementationAgent.skills.mode).toBe("from_planner_selection");
    expect(implementationAgent.skills.allowed).toContain("skills/tdd");
    expect(implementationAgent.skills.allowed).not.toContain("skills/code-review");

    const loader = createWorkflowSkillLoader({ repoRoot });
    const allowList = await loader.computeAllowList({
      stepId: implementationAgent.phase,
      plannerSelection: implementationAgent.skills.allowed,
    });

    expect(allowList).toEqual([
      "skills/implement",
      "skills/tdd",
      "skills/codebase-design",
      "skills/diagnosing-bugs",
    ]);

    await expect(loader.loadSkill("skills/code-review", allowList)).rejects.toBeInstanceOf(
      SkillBudgetDeniedError,
    );
    await expect(loader.loadSkill("skills/code-review", allowList)).rejects.toMatchObject({
      code: "SKILL_BUDGET_DENIED",
      skillId: "skills/code-review",
    });
    await expect(loader.loadSkill("skills/not-indexed", ["skills/tdd"])).rejects.toMatchObject({
      code: "SKILL_BUDGET_DENIED",
      skillId: "skills/not-indexed",
    });

    const loaded = await loader.loadSkill("skills/tdd", allowList);
    expect(loaded.id).toBe("skills/tdd");
    expect(loaded.body).toContain("name: tdd");
    expect(loaded.body).not.toContain("name: code-review");
    expect(loaded.sourcePath).toBe(path.resolve(repoRoot, ".cursor", "skills", "tdd"));
  });
});
