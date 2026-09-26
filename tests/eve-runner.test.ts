import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { CodingAgent, CodingAgentInput } from "../src/adapters/coding-agent.js";
import { readExitGates } from "../src/eve/assemble.js";
import { EveRequestError } from "../src/eve/contract.js";
import { executeCli } from "../src/eve/cli.js";
import { startEveHttpServer } from "../src/eve/http.js";
import { runEveStep } from "../src/eve/run-step.js";
import { createWorktreeSandbox, SandboxEscapeError } from "../src/eve/sandbox.js";
import { SkillBudgetDeniedError, createWorkflowSkillLoader } from "../src/eve/skill-loader.js";
import { runEveStageStep } from "../src/orchestrator/jobs/stage-worker.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function worktree(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "eve-wt-"));
  dirs.push(dir);
  return dir;
}

function stepInput(worktreePath: string, overrides: Record<string, unknown> = {}) {
  return {
    taskId: "t-60",
    stepId: "implementation",
    worktreePath,
    agentId: "agents/implementation",
    skillBudget: ["skills/bot-session"],
    specialistsAllowed: ["specialists/back-end"],
    codingBackend: "sandbox" as const,
    ...overrides,
  };
}

describe("eve-runner contract", () => {
  it("runs one step from the stage worker and does not advance the graph", async () => {
    const cwd = await worktree();
    const calls: CodingAgentInput[] = [];
    const adapter: CodingAgent = {
      id: "cursor",
      async run(input) {
        calls.push(input);
        return {
          pr_ready: false,
          diff_summary: "noop",
          status: "succeeded",
          usage: { provider: "cursor", input_tokens: 1, output_tokens: 1 },
        };
      },
    };
    const result = await runEveStageStep(stepInput(cwd, { codingBackend: "cursor" }), {
      repoRoot,
      adapters: { cursor: adapter },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.worktree_path).toBe(realpathSync(cwd));
    expect(calls[0]?.budget.maxToolRounds).toBe(1);
    expect(calls[0]?.allowed_tools).toEqual(["read_file", "write_file", "bash", "load_skill"]);
    expect(calls[0]?.metadata).toMatchObject({
      task_id: "t-60",
      step_id: "implementation",
      agent_id: "agents/implementation",
    });
    expect(calls[0]?.instructions).toContain("Never advance the workflow graph yourself");
    expect(calls[0]?.instructions).toContain("name: bot-session");
    expect(calls[0]?.instructions).not.toContain("Three-axis review");
    expect(calls[0]?.instructions).toContain("specialists/back-end");
    expect(result.graphAdvanced).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.exitGateHints.owner).toBe("orchestrator");
    expect(result.exitGateHints.gates).toEqual([
      { id: "jev_completion", hint: "unknown" },
      { id: "local_checks", hint: "unknown" },
    ]);
    expect(result.artifacts.skillsLoaded.map((skill) => skill.id)).toEqual(["skills/bot-session"]);
    expect(result.artifacts.skillsLoaded[0]?.path).toContain(".cursor/skills/bot-session/SKILL.md");
  });

  it("denies skills outside the budget and unknown specialists", async () => {
    const cwd = await worktree();
    const loader = createWorkflowSkillLoader({ repoRoot });
    await expect(
      loader.loadSkill("skills/code-review", ["skills/bot-session"]),
    ).rejects.toBeInstanceOf(SkillBudgetDeniedError);
    await expect(
      loader.loadSkill("skills/not-a-skill", ["skills/not-a-skill"]),
    ).rejects.toBeInstanceOf(SkillBudgetDeniedError);

    const result = await runEveStep(
      stepInput(cwd, {
        skillBudget: ["skills/bot-session", "skills/not-a-skill", "skills/bot-session"],
        specialistsAllowed: ["specialists/database", "specialists/not-real"],
      }),
      { repoRoot },
    );
    expect(result.artifacts.skillsLoaded.map((skill) => skill.id)).toEqual(["skills/bot-session"]);
    expect(result.artifacts.skillsDenied).toEqual([
      { id: "skills/not-a-skill", reason: "outside_budget" },
    ]);
    expect(result.artifacts.systemPrompt).not.toContain("Three-axis review");
    expect(result.artifacts.specialistsAllowed).toEqual(["specialists/database"]);
    expect(result.artifacts.specialistsUnknown).toEqual(["specialists/not-real"]);
    expect(result.graphAdvanced).toBe(false);
  });

  it("maps an unimplemented cursor adapter to a failed step without advancing", async () => {
    const cwd = await worktree();
    const result = await runEveStep(stepInput(cwd, { codingBackend: "cursor" }), {
      repoRoot,
      env: {},
    });
    expect(result.ok).toBe(false);
    expect(result.graphAdvanced).toBe(false);
    expect(result.artifacts.adapter.status).toBe("failed");
    expect(result.artifacts.adapter.error_class).toBe("missing_credentials");
    expect(result.exitGateHints.gates.every((gate) => gate.hint === "fail")).toBe(true);
  });

  it("rejects a missing worktree and a traversal agent id", async () => {
    await expect(
      runEveStep(stepInput(path.join(tmpdir(), "eve-missing-worktree")), { repoRoot }),
    ).rejects.toMatchObject({ errorClass: "worktree_not_found" });
    await expect(
      runEveStep(stepInput(await worktree(), { agentId: "agents/../secrets" }), { repoRoot }),
    ).rejects.toBeInstanceOf(EveRequestError);
  });

  it("reads exit gates from the default workflow", () => {
    const yaml = [
      "steps:",
      "  - id: planner",
      "    exit_gates: [plan_present, jev_route_ok]",
      "  - id: implementation",
      "    exit_gates: [jev_completion, local_checks]",
      "",
    ].join("\n");
    expect(readExitGates(yaml, "planner")).toEqual(["plan_present", "jev_route_ok"]);
    expect(readExitGates(yaml, "missing")).toEqual([]);
  });
});

describe("worktree sandbox", () => {
  it("confines read, write, and bash to the worktree cwd", async () => {
    const cwd = await worktree();
    const loader = createWorkflowSkillLoader({ repoRoot });
    const sandbox = createWorktreeSandbox(cwd, {
      loadSkill: async (skillId) => {
        try {
          const skill = await loader.loadSkill(skillId, ["skills/bot-session"]);
          return { ok: true, id: skill.id, path: skill.sourcePath, body: skill.body };
        } catch (error) {
          if (error instanceof SkillBudgetDeniedError) {
            return { ok: false, id: skillId, reason: "outside_budget" as const };
          }
          throw error;
        }
      },
    });
    await sandbox.writeFile("notes/plan.txt", "ok");
    expect(await sandbox.readFile("notes/plan.txt")).toBe("ok");
    await expect(sandbox.readFile("../package.json")).rejects.toBeInstanceOf(SandboxEscapeError);
    await expect(sandbox.writeFile("/etc/passwd", "no")).rejects.toBeInstanceOf(SandboxEscapeError);
    const pwd = await sandbox.bash("pwd");
    expect(pwd.exitCode).toBe(0);
    expect(pwd.stdout.trim()).toBe(sandbox.cwd);
    const denied = await sandbox.loadSkill("skills/code-review");
    expect(denied).toMatchObject({ ok: false, reason: "outside_budget" });
    const loaded = await sandbox.loadSkill("skills/bot-session");
    expect(loaded.ok).toBe(true);
  });
});

describe("eve-runner http and cli", () => {
  it("serves health and one step", async () => {
    const cwd = await worktree();
    const started = await startEveHttpServer({ repoRoot });
    try {
      const health = await fetch(`${started.url}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true, service: "eve-runner" });
      const missing = await fetch(`${started.url}/nope`);
      expect(missing.status).toBe(404);
      const posted = await fetch(`${started.url}/v1/steps`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(stepInput(cwd)),
      });
      expect(posted.status).toBe(200);
      const body = (await posted.json()) as { graphAdvanced: boolean; ok: boolean };
      expect(body.ok).toBe(true);
      expect(body.graphAdvanced).toBe(false);
      const bad = await fetch(`${started.url}/v1/steps`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      });
      expect(bad.status).toBe(400);
    } finally {
      await started.close();
    }
  });

  it("runs from the CLI and checks health", async () => {
    const cwd = await worktree();
    const started = await startEveHttpServer({ repoRoot, port: 0 });
    try {
      const health = await executeCli(["health", "--url", `${started.url}/health`]);
      expect(health.exitCode).toBe(0);
      expect(health.stdout).toContain("eve-runner");
      const run = await executeCli([
        "run",
        "--json",
        JSON.stringify(stepInput(cwd, { skillBudget: [], specialistsAllowed: [] })),
      ]);
      expect(run.exitCode).toBe(0);
      const parsed = JSON.parse(run.stdout) as { graphAdvanced: boolean; ok: boolean };
      expect(parsed.graphAdvanced).toBe(false);
      expect(parsed.ok).toBe(true);
      expect(run.stderr).toContain('"graphAdvanced":false');
    } finally {
      await started.close();
    }
  });
});

describe("runner ownership", () => {
  it("does not import BullMQ from the runner or the stage processor", async () => {
    const eveDir = path.join(repoRoot, "src", "eve");
    const files = [
      "contract.ts",
      "skill-loader.ts",
      "sandbox.ts",
      "assemble.ts",
      "run-step.ts",
      "http.ts",
      "cli.ts",
      "index.ts",
    ];
    for (const file of files) {
      const source = await readFile(path.join(eveDir, file), "utf8");
      expect(source).not.toMatch(/from ["']bullmq["']/);
    }
    const worker = await readFile(
      path.join(repoRoot, "src/orchestrator/jobs/stage-worker.ts"),
      "utf8",
    );
    expect(worker).not.toMatch(/from ["']bullmq["']/);
    expect(worker).not.toMatch(/\bnew Worker\b/);
    expect(worker).not.toMatch(/\bnew Queue\b/);
  });
});
