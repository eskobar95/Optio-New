import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PhaseAgentDefinition } from "../agents/contract.js";
import { implementationAgent } from "../agents/implementation/agent.js";
import { mergeAgent } from "../agents/merge/agent.js";
import { plannerAgent } from "../agents/planner/agent.js";
import { readyAgent } from "../agents/ready/agent.js";
import { reviewAgent } from "../agents/review/agent.js";

const ROOT = process.cwd();

const PHASES: PhaseAgentDefinition[] = [
  plannerAgent,
  implementationAgent,
  reviewAgent,
  readyAgent,
  mergeAgent,
];

function stepBlock(yaml: string, stepId: string): string {
  const match = yaml.match(new RegExp(`- id: ${stepId}\\n([\\s\\S]*?)(?=\\n  - id: |$)`));
  if (!match?.[1]) throw new Error(`missing workflow step ${stepId}`);
  return match[1];
}

function bracketList(block: string, key: string): string[] {
  const inline = block.match(new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`));
  if (!inline) throw new Error(`missing ${key}`);
  return (inline[1] ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function scalar(block: string, key: string): string | undefined {
  return block.match(new RegExp(`${key}:\\s*([^\\s#]+)`))?.[1];
}

describe("Eve phase exit gates", () => {
  it("copies workflow entry and exit gates onto each phase agent", async () => {
    const workflow = await readFile(path.join(ROOT, "workflows/default-task.yaml"), "utf8");
    const agentsMd = await readFile(path.join(ROOT, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("docs/eve-patterns.md");

    for (const agent of PHASES) {
      const block = stepBlock(workflow, agent.phase);
      expect([...agent.gates.entry]).toEqual(bracketList(block, "entry_gates"));
      expect([...agent.gates.exit]).toEqual(bracketList(block, "exit_gates"));
      expect(agent.gates.onFail).toBe(scalar(block, "on_fail"));
      expect(agent.gates.onSuccess).toBe(scalar(block, "on_success"));
      expect(agent.toolPolicy.advancesWorkflow).toBe(false);

      const instructions = await readFile(
        path.join(ROOT, "agents", agent.phase, "instructions.md"),
        "utf8",
      );
      expect(instructions).toContain("workflows/default-task.yaml");
      expect(instructions).toContain("does not advance BullMQ");
      expect(instructions).not.toMatch(/\bLinear\b/);
      for (const gate of [...agent.gates.entry, ...agent.gates.exit]) {
        expect(instructions, gate).toContain(gate);
      }
      if (agent.gates.onFail) expect(instructions).toContain(agent.gates.onFail);
      if (agent.gates.onSuccess) expect(instructions).toContain(agent.gates.onSuccess);
    }
  });
});
