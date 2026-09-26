import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PhaseAgentDefinition, SpecialistDefinition } from "../agents/contract.js";
import { implementationAgent } from "../agents/implementation/agent.js";
import { mergeAgent } from "../agents/merge/agent.js";
import { plannerAgent } from "../agents/planner/agent.js";
import { readyAgent } from "../agents/ready/agent.js";
import { reviewAgent } from "../agents/review/agent.js";
import { backEndSpecialist } from "../specialists/back-end/agent.js";
import { databaseSpecialist } from "../specialists/database/agent.js";
import { devopsSpecialist } from "../specialists/devops/agent.js";
import { frontEndSpecialist } from "../specialists/front-end/agent.js";

const ROOT = process.cwd();

const PHASES: { dir: string; agent: PhaseAgentDefinition }[] = [
  { dir: "planner", agent: plannerAgent },
  { dir: "implementation", agent: implementationAgent },
  { dir: "review", agent: reviewAgent },
  { dir: "ready", agent: readyAgent },
  { dir: "merge", agent: mergeAgent },
];

const SPECIALISTS: SpecialistDefinition[] = [
  frontEndSpecialist,
  backEndSpecialist,
  devopsSpecialist,
  databaseSpecialist,
];

interface CatalogSkill {
  id: string;
  cursor_native_id: string;
  cursor_native_path: string;
  phase_tags: string[];
}

interface PhaseSkillIndex {
  source_of_truth_root: string;
  budget_mode: "fixed" | "from_planner_selection";
  skills: { id: string; cursor_native_id: string; cursor_native_path: string }[];
}

interface SpecialistIndex {
  source_of_truth_root: string;
  specialists: {
    id: string;
    slot_dir: string;
    cursor_native_path: string;
    cursor_native_id: string;
  }[];
}

async function readJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(await readFile(path.join(ROOT, relativePath), "utf8")) as T;
}

function stepBlock(yaml: string, stepId: string): string {
  const match = yaml.match(new RegExp(`- id: ${stepId}\\n([\\s\\S]*?)(?=\\n  - id: |$)`));
  if (!match?.[1]) throw new Error(`missing workflow step ${stepId}`);
  return match[1];
}

function skillsAllowed(yaml: string, stepId: string): string[] | "from_planner_selection" {
  const line = stepBlock(yaml, stepId).match(/skills_allowed:\s*(.+)/)?.[1];
  if (!line) throw new Error(`missing skills_allowed for ${stepId}`);
  const value = line.split("#")[0]?.trim() ?? "";
  if (value === "from_planner_selection") return value;
  const inner = value.match(/^\[(.*)\]$/)?.[1];
  if (inner === undefined) throw new Error(`bad skills_allowed for ${stepId}`);
  return inner
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function specialistsAllowed(yaml: string, stepId: string): string[] {
  const block = stepBlock(yaml, stepId);
  const inline = block.match(/specialists_allowed:\s*\[([^\]]*)\]/);
  if (inline) {
    return (inline[1] ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }
  const list = block.match(/specialists_allowed:\s*\n((?:\s+- .+\n)+)/);
  if (!list?.[1]) return [];
  return [...list[1].matchAll(/^\s+- (\S+)/gm)].map((match) => match[1] ?? "");
}

describe("Eve phase slots", () => {
  it("gives each phase agent instructions, an empty tools slot, and a skill ref index", async () => {
    const workflow = await readFile(path.join(ROOT, "workflows/default-task.yaml"), "utf8");
    const catalog = await readJson<{ source_of_truth_root: string; skills: CatalogSkill[] }>(
      "skills/index.json",
    );
    expect(catalog.source_of_truth_root).toBe(".cursor/skills");

    for (const { dir, agent } of PHASES) {
      const phaseDir = path.join(ROOT, "agents", dir);
      const instructions = await readFile(path.join(phaseDir, "instructions.md"), "utf8");
      expect(instructions).toContain("skills/index.json");
      expect(instructions).toContain(".cursor/skills");
      expect(instructions).toContain("BullMQ");

      const toolFiles = await readdir(path.join(phaseDir, "tools"));
      expect(toolFiles).toEqual(["README.md"]);
      expect(agent.toolPolicy.localTools).toEqual([]);
      expect(agent.toolPolicy.advancesWorkflow).toBe(false);
      expect(agent.model.selection).toBe("orchestrator");

      const index = await readJson<PhaseSkillIndex>(`agents/${dir}/skills/index.json`);
      const skillFiles = await readdir(path.join(phaseDir, "skills"));
      expect(skillFiles).toEqual(["index.json"]);
      expect(index.source_of_truth_root).toBe(".cursor/skills");
      expect(index.budget_mode).toBe(agent.skills.mode);
      expect(index.skills.map((skill) => skill.id)).toEqual([...agent.skills.allowed]);

      for (const skill of index.skills) {
        const catalogSkill = catalog.skills.find((entry) => entry.id === skill.id);
        expect(catalogSkill, skill.id).toBeDefined();
        expect(skill.cursor_native_path).toBe(catalogSkill?.cursor_native_path);
        expect(skill.cursor_native_id).toBe(catalogSkill?.cursor_native_id);
        const body = path.join(ROOT, skill.cursor_native_path, "SKILL.md");
        await readFile(body, "utf8");
      }

      const budget = skillsAllowed(workflow, dir);
      if (budget === "from_planner_selection") {
        expect(agent.skills.mode).toBe("from_planner_selection");
        const candidates = catalog.skills
          .filter((skill) => skill.phase_tags.includes("implementation"))
          .map((skill) => skill.id);
        expect([...agent.skills.allowed]).toEqual(candidates);
      } else {
        expect(agent.skills.mode).toBe("fixed");
        expect([...agent.skills.allowed]).toEqual(budget);
      }

      const allowedSpecialists = specialistsAllowed(workflow, dir);
      expect([...agent.specialistsAllowed]).toEqual(allowedSpecialists);
    }
  });

  it("does not vendor skill bodies under phase or specialist slots", async () => {
    const roots = ["agents", "specialists"];
    for (const root of roots) {
      const stack = [path.join(ROOT, root)];
      const copied: string[] = [];
      while (stack.length > 0) {
        const current = stack.pop();
        if (!current) break;
        for (const entry of await readdir(current, { withFileTypes: true })) {
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) stack.push(full);
          else if (entry.name === "SKILL.md") copied.push(full);
        }
      }
      expect(copied).toEqual([]);
    }
  });
});

describe("Eve specialist slots", () => {
  it("mirrors subagents and keeps specialists/index.json on .cursor/agents", async () => {
    const index = await readJson<SpecialistIndex>("specialists/index.json");
    expect(index.source_of_truth_root).toBe(".cursor/agents");
    expect(index.specialists.map((entry) => entry.id)).toEqual(
      SPECIALISTS.map((entry) => entry.id),
    );

    for (const spec of SPECIALISTS) {
      const row = index.specialists.find((entry) => entry.id === spec.id);
      expect(row?.slot_dir).toBe(spec.id);
      expect(row?.cursor_native_path).toBe(spec.cursorNativePath);
      expect(row?.cursor_native_id).toBe(spec.cursorNativeId);
      expect(spec.toolPolicy.advancesWorkflow).toBe(false);
      expect(spec.toolPolicy.localTools).toEqual([]);

      const slot = path.join(ROOT, spec.id);
      const instructions = await readFile(path.join(slot, "instructions.md"), "utf8");
      const canonical = await readFile(path.join(ROOT, spec.cursorNativePath), "utf8");
      const canonicalBody = canonical.replace(/^---[\s\S]*?---\n/, "").trim();
      expect(instructions).toContain(spec.cursorNativePath);
      expect(instructions).not.toContain(canonicalBody);

      const toolFiles = await readdir(path.join(slot, "tools"));
      expect(toolFiles).toEqual(["README.md"]);
    }
  });
});

describe("eve-patterns doc", () => {
  it("records BullMQ, worktrees, and the Vercel products Optio does not use", async () => {
    const doc = await readFile(path.join(ROOT, "docs/eve-patterns.md"), "utf8");
    expect(doc).toContain("BullMQ");
    expect(doc).toContain("worktree");
    expect(doc).toContain("Vercel Workflows");
    expect(doc).toContain("Vercel Sandbox");
    expect(doc).toContain(".cursor/skills");
    expect(doc).toContain("specialists/index.json");
    expect(doc).toContain("Dockerfile.eve-runner");
  });
});
