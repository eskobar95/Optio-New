import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  IMPLEMENTATION_PARENT_TOOLS,
  InMemoryStepCursorStore,
  SPECIALIST_IDS,
  STEP_ADVANCE_TOOLS,
  SpecialistInvokeError,
  createStageTracer,
  dispatchSpecialistTool,
  invokeSpecialist,
  loadSpecialistCatalog,
  type SpecialistCatalog,
  type SpecialistExecutor,
  type SpecialistId,
} from "../src/index.js";

const PARENT_SECRET = "PARENT_SECRET_TURN";

const parentTools = [...IMPLEMENTATION_PARENT_TOOLS, ...STEP_ADVANCE_TOOLS];

const parent = {
  taskId: "t-1",
  stepId: "implementation",
  worktreePath: "/worktrees/wt-t-1",
  worktreeId: "wt-t-1",
  agentId: "agents/implementation",
  skillBudget: [
    "skills/tdd",
    "skills/codebase-design",
    "skills/diagnosing-bugs",
    "skills/code-review",
    "skills/land",
    "skills/bot-session",
  ],
  specialistsAllowed: [...SPECIALIST_IDS],
  history: [{ role: "user", content: PARENT_SECRET }],
  tools: parentTools,
};

function invoke(specialistId: SpecialistId, execute?: SpecialistExecutor) {
  return invokeSpecialist(
    { parent, specialistId, task: `work for ${specialistId}` },
    {
      sessionId: () => `sess-${specialistId}`,
      now: () => new Date("2026-09-26T00:00:00.000Z"),
      ...(execute ? { execute } : {}),
    },
  );
}

describe("specialist invoke", () => {
  it("lets implementation invoke each specialist on the shared worktree", async () => {
    for (const specialistId of SPECIALIST_IDS) {
      let seenPath = "";
      let seenMessages: readonly unknown[] = ["unset"];
      const result = await invoke(specialistId, async (request) => {
        seenPath = request.worktreePath;
        seenMessages = request.messages;
        expect(JSON.stringify(request)).not.toContain(PARENT_SECRET);
        const extra = { summary: "done", nextStep: "review", stepAdvanced: true };
        return extra;
      });

      expect(seenPath).toBe(parent.worktreePath);
      expect(seenMessages).toEqual([]);
      expect(result.worktreePath).toBe(parent.worktreePath);
      expect(result.sharedWorktree).toBe(true);
      expect(result.messages).toEqual([]);
      expect(result.sessionId).toBe(`sess-${specialistId}`);
      expect(result.stepAdvanced).toBe(false);
      expect(result.summary).toBe("done");
      expect(result).not.toHaveProperty("nextStep");
      expect(result.skillBudget.length).toBeGreaterThan(0);
      expect(result.skillBudget.length).toBeLessThan(parent.skillBudget.length);
      expect(result.skillBudget.every((id) => parent.skillBudget.includes(id))).toBe(true);
      expect(result.skillBudget).not.toContain("skills/code-review");
      expect(result.skillBudget).not.toContain("skills/land");
      expect(result.skillBudget).not.toContain("skills/bot-session");
      expect(result.allowedTools.length).toBeLessThan(parent.tools.length);
      expect(result.allowedTools).not.toContain("advance_step");
      expect(result.allowedTools).not.toContain("invoke_specialist");
      expect(result.allowedTools).not.toContain("shell");
      expect(result.systemPrompt).not.toContain(PARENT_SECRET);
      expect(result.systemPrompt).toContain("Do not advance the workflow");
      expect(dispatchSpecialistTool(result, "read_file")).toEqual({ ok: true, tool: "read_file" });
    }
  });

  it("gives front-end a narrower tool set than back-end", async () => {
    const front = await invoke("specialists/front-end");
    const back = await invoke("specialists/back-end");
    expect(front.allowedTools).not.toContain("bash");
    expect(back.allowedTools).toContain("bash");
    expect(front.skillBudget).toEqual(["skills/tdd", "skills/codebase-design"]);
    expect(back.skillBudget).toEqual(["skills/tdd", "skills/diagnosing-bugs"]);
    expect(front.systemPrompt).toContain("client UI");
  });

  it("starts a fresh session and leaves the BullMQ cursor where it was", async () => {
    const cursors = new InMemoryStepCursorStore();
    const before = {
      taskId: "t-1",
      sessionId: "s-1",
      stage: "implement" as const,
      nextStepIndex: 1,
      status: "running" as const,
      updatedAt: "2026-09-26T00:00:00.000Z",
    };
    await cursors.save(before);

    const first = await invokeSpecialist(
      { parent, specialistId: "specialists/database", task: "add index" },
      { now: () => new Date("2026-09-26T00:00:00.000Z") },
    );
    const second = await invokeSpecialist(
      { parent, specialistId: "specialists/database", task: "add index" },
      { now: () => new Date("2026-09-26T00:00:00.000Z") },
    );

    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.messages).toEqual([]);
    expect(second.messages).toEqual([]);
    expect(await cursors.get("t-1", "s-1", "implement")).toEqual(before);
    expect(first.stepAdvanced).toBe(false);
  });

  it("denies step advance from the specialist tool gate and from invoke input", async () => {
    const result = await invoke("specialists/devops");
    expect(() => dispatchSpecialistTool(result, "advance_step")).toThrow(SpecialistInvokeError);
    expect(() => dispatchSpecialistTool(result, "bullmq.advance")).toThrowError(
      expect.objectContaining({ code: "step_advance_denied" }),
    );
    await expect(
      invokeSpecialist({
        parent,
        specialistId: "specialists/devops",
        task: "ci",
        advanceStep: true,
      }),
    ).rejects.toMatchObject({ code: "step_advance_denied" });
    await expect(
      invokeSpecialist({
        parent: { ...parent, cursor: { nextStepIndex: 2 } },
        specialistId: "specialists/devops",
        task: "ci",
      }),
    ).rejects.toMatchObject({ code: "step_advance_denied" });
  });

  it("strips advance tools and other-phase skills even when the folder lists them", async () => {
    const catalog: SpecialistCatalog = {
      implementationAllowed: ["specialists/front-end"],
      get(id) {
        if (id !== "specialists/front-end") return undefined;
        return {
          id: "specialists/front-end",
          cursorNativePath: ".cursor/agents/frontend.md",
          responsibility: "ui",
          tools: ["read_file", "advance_step", "invoke_specialist", "shell"],
          skills: ["skills/tdd", "skills/land", "skills/code-review", "skills/missing"],
          instructions: "Focus on UI.",
        };
      },
    };
    const result = await invokeSpecialist(
      {
        parent: {
          ...parent,
          skillBudget: ["skills/tdd", "skills/land", "skills/code-review"],
        },
        specialistId: "specialists/front-end",
        task: "button",
      },
      { catalog, sessionId: () => "fixed" },
    );
    expect(result.allowedTools).toEqual(["read_file", "shell"]);
    expect(result.skillBudget).toEqual(["skills/tdd"]);
    expect(result.worktreePath).toBe(parent.worktreePath);
    expect(() => dispatchSpecialistTool(result, "advance_step")).toThrow(SpecialistInvokeError);
  });

  it("refuses specialists outside the parent step or the workflow allow-list", async () => {
    await expect(invoke("specialists/front-end")).resolves.toMatchObject({
      specialistId: "specialists/front-end",
    });
    await expect(
      invokeSpecialist({
        parent: { ...parent, stepId: "review", agentId: "agents/review", specialistsAllowed: [] },
        specialistId: "specialists/front-end",
        task: "nudge",
      }),
    ).rejects.toMatchObject({ code: "parent_step_forbidden" });
    await expect(
      invokeSpecialist({
        parent: { ...parent, specialistsAllowed: ["specialists/database"] },
        specialistId: "specialists/front-end",
        task: "nudge",
      }),
    ).rejects.toMatchObject({ code: "specialist_not_allowed" });
    await expect(
      invokeSpecialist({
        parent,
        specialistId: "specialists/review",
        task: "nudge",
      }),
    ).rejects.toMatchObject({ code: "unknown_specialist" });
  });

  it("records specialist.call with the shared worktree path", async () => {
    const tracer = createStageTracer();
    const result = await invokeSpecialist(
      { parent, specialistId: "specialists/database", task: "migration" },
      { tracer, sessionId: () => "span-session" },
    );
    const spans = tracer.finished().filter((span) => span.name === "specialist.call");
    expect(spans).toHaveLength(1);
    expect(spans[0]?.attributes).toMatchObject({
      task_id: "t-1",
      worktree_id: "wt-t-1",
      specialist_id: "specialists/database",
      step_id: "implementation",
      agent_id: "agents/implementation",
      worktree_path: parent.worktreePath,
    });
    expect(result.worktreePath).toBe(spans[0]?.attributes.worktree_path);
    await tracer.shutdown();
  });

  it("loads the four specialists from the workflow allow-list", async () => {
    const catalog = await loadSpecialistCatalog();
    expect([...catalog.implementationAllowed]).toEqual([...SPECIALIST_IDS]);
    for (const id of SPECIALIST_IDS) {
      const record = catalog.get(id);
      expect(record?.id).toBe(id);
      expect(record?.instructions.length).toBeGreaterThan(0);
      for (const tool of STEP_ADVANCE_TOOLS) {
        expect(record?.tools).not.toContain(tool);
      }
    }
  });

  it("does not import the stage graph", () => {
    const source = readFileSync(
      new URL("../src/orchestrator/specialists/invoke.ts", import.meta.url),
      "utf8",
    );
    const imports = source.split("\n").filter((line) => line.startsWith("import"));
    expect(imports.join("\n")).not.toMatch(/bullmq|run-stage|jobs\/cursor|enqueue-pipeline/);
  });
});
