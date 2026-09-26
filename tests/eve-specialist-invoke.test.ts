import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { implementationAgent } from "../agents/implementation/agent.js";
import {
  IMPLEMENTATION_STEP_ID,
  InMemoryStepCursorStore,
  SPECIALIST_IDS,
  SpecialistInvokeError,
  dispatchSpecialistTool,
  invokeSpecialist,
} from "../src/index.js";

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const PARENT_SECRET = "prior implementation turn";

function parent(worktreePath: string, specialistsAllowed: readonly string[] = SPECIALIST_IDS) {
  return {
    taskId: "t-eve-5",
    stepId: IMPLEMENTATION_STEP_ID,
    worktreePath,
    worktreeId: "wt-t-eve-5",
    agentId: implementationAgent.id,
    skillBudget: [
      ...implementationAgent.skills.allowed,
      "skills/code-review",
      "skills/bot-session",
    ],
    specialistsAllowed: [...specialistsAllowed],
    history: [{ role: "user", content: PARENT_SECRET }],
    tools: ["read_file", "edit_file", "bash", "shell", "advance_step", "enqueue_job"],
  };
}

async function worktree(): Promise<string> {
  const worktreePath = await mkdtemp(path.join(tmpdir(), "optio-eve-shared-"));
  cleanups.push(worktreePath);
  return worktreePath;
}

describe("Eve specialist invoke", () => {
  it("runs the specialist in the shared worktree and does not advance BullMQ", async () => {
    const worktreePath = await worktree();
    const cursors = new InMemoryStepCursorStore();
    const before = {
      taskId: "t-eve-5",
      sessionId: "s-eve-5",
      stage: "implement" as const,
      nextStepIndex: 1,
      status: "running" as const,
      updatedAt: "2026-09-26T00:00:00.000Z",
    };
    await cursors.save(before);

    let seenPath = "";
    let seenMessages: readonly unknown[] = ["unset"];
    const result = await invokeSpecialist(
      {
        parent: parent(worktreePath),
        specialistId: "specialists/back-end",
        task: "service",
      },
      {
        sessionId: () => "sess-back-end",
        now: () => new Date("2026-09-26T00:00:00.000Z"),
        execute: async (request) => {
          seenPath = request.worktreePath;
          seenMessages = request.messages;
          expect(JSON.stringify(request)).not.toContain(PARENT_SECRET);
          const extra = { summary: "done", nextStep: "review", stepAdvanced: true };
          return extra;
        },
      },
    );

    expect(seenPath).toBe(worktreePath);
    expect(seenMessages).toEqual([]);
    expect(result).toMatchObject({
      specialistId: "specialists/back-end",
      worktreePath,
      sharedWorktree: true,
      stepAdvanced: false,
      messages: [],
      skillBudget: ["skills/tdd", "skills/diagnosing-bugs"],
      summary: "done",
      parent: {
        taskId: "t-eve-5",
        stepId: "implementation",
        agentId: "agents/implementation",
      },
    });
    expect(result).not.toHaveProperty("nextStep");
    expect(result.allowedTools).toEqual(["read_file", "edit_file", "bash"]);
    expect(result.allowedTools).not.toContain("advance_step");
    expect(result.allowedTools).not.toContain("enqueue_job");
    expect(await cursors.get("t-eve-5", "s-eve-5", "implement")).toEqual(before);
    expect(() => dispatchSpecialistTool(result, "bullmq.advance")).toThrow(SpecialistInvokeError);
    expect(() => dispatchSpecialistTool(result, "enqueue_job")).toThrowError(
      expect.objectContaining({ code: "step_advance_denied" }),
    );
    await expect(
      invokeSpecialist({
        parent: parent(worktreePath),
        specialistId: "specialists/back-end",
        task: "service",
        enqueue: true,
      }),
    ).rejects.toMatchObject({ code: "step_advance_denied" });
  });

  it("does not advance when the specialist id is outside specialists_allowed", async () => {
    const worktreePath = await worktree();
    const cursors = new InMemoryStepCursorStore();
    const before = {
      taskId: "t-eve-5",
      sessionId: "s-eve-5",
      stage: "implement" as const,
      nextStepIndex: 0,
      status: "pending" as const,
      updatedAt: "2026-09-26T00:00:00.000Z",
    };
    await cursors.save(before);

    await expect(
      invokeSpecialist({
        parent: parent(worktreePath, ["specialists/database"]),
        specialistId: "specialists/back-end",
        task: "service",
      }),
    ).rejects.toMatchObject({
      name: "SpecialistInvokeError",
      code: "specialist_not_allowed",
    });
    expect(await cursors.get("t-eve-5", "s-eve-5", "implement")).toEqual(before);
  });

  it("invokes each implementation specialist on the same worktree without advancing the stage", async () => {
    const worktreePath = await worktree();
    const paths: string[] = [];

    expect([...implementationAgent.specialistsAllowed]).toEqual([...SPECIALIST_IDS]);
    for (const specialistId of SPECIALIST_IDS) {
      const result = await invokeSpecialist(
        {
          parent: parent(worktreePath),
          specialistId,
          task: `work for ${specialistId}`,
        },
        {
          execute: async (request) => {
            paths.push(request.worktreePath);
            return { summary: "ok" };
          },
        },
      );
      expect(result.worktreePath).toBe(worktreePath);
      expect(result.sharedWorktree).toBe(true);
      expect(result.stepAdvanced).toBe(false);
      expect(result.messages).toEqual([]);
    }

    expect(paths).toEqual([worktreePath, worktreePath, worktreePath, worktreePath]);
    expect(implementationAgent.toolPolicy.advancesWorkflow).toBe(false);
  });
});
