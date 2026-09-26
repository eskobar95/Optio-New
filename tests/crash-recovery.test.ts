import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  InMemoryStepCursorStore,
  JsonFileStepCursorStore,
  readStageCheckpoint,
  runPipeline,
  type StageStepHandler,
} from "../src/index.js";

const identity = { taskId: "t-1", sessionId: "s-1" };
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function recordingHandler(calls: string[], crashOn?: string): StageStepHandler {
  let armed = crashOn !== undefined;
  return {
    async run(ctx) {
      const key = `${ctx.stage}:${ctx.step}`;
      if (armed && key === crashOn) {
        armed = false;
        throw new Error("worker crashed");
      }
      calls.push(key);
    },
  };
}

describe("stage checkpoint resume", () => {
  it("resumes from the last completed stage after the orchestrator is replaced", async () => {
    const calls: string[] = [];
    const cursors = new InMemoryStepCursorStore();
    await expect(
      runPipeline(identity, {
        cursors,
        handler: recordingHandler(calls, "implement:record_diff"),
      }),
    ).rejects.toThrow(/worker crashed/);

    const checkpoint = await readStageCheckpoint(cursors, identity.taskId, identity.sessionId);
    expect(checkpoint).toEqual({
      taskId: "t-1",
      sessionId: "s-1",
      lastCompletedStage: "plan",
      resumeStage: "implement",
    });
    const failed = await cursors.get(identity.taskId, identity.sessionId, "implement");
    expect(failed).toMatchObject({ status: "failed", nextStepIndex: 1 });

    calls.length = 0;
    const resumed = await runPipeline(identity, {
      cursors,
      handler: recordingHandler(calls),
    });
    expect(calls[0]).toBe("implement:record_diff");
    expect(calls).not.toContain("plan:ack_session");
    expect(calls).not.toContain("plan:invoke_planner");
    expect(calls).not.toContain("implement:invoke_implementation");
    expect(resumed.stages.every((stage) => stage.status === "completed")).toBe(true);

    const done = await readStageCheckpoint(cursors, identity.taskId, identity.sessionId);
    expect(done.resumeStage).toBeNull();
    expect(done.lastCompletedStage).toBe("merge");
  });

  it("reloads a file cursor in a second store instance", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "optio-cursor-"));
    dirs.push(dir);
    const file = path.join(dir, "cursor.json");
    const first = new JsonFileStepCursorStore(file);
    await first.save({
      taskId: "t-1",
      sessionId: "s-1",
      stage: "implement",
      nextStepIndex: 1,
      status: "failed",
      updatedAt: "2026-09-26T00:00:00.000Z",
    });
    const second = new JsonFileStepCursorStore(file);
    await expect(second.get("t-1", "s-1", "implement")).resolves.toMatchObject({
      nextStepIndex: 1,
      status: "failed",
    });
    await expect(readStageCheckpoint(second, "t-1", "s-1")).resolves.toMatchObject({
      lastCompletedStage: null,
      resumeStage: "plan",
    });
  });
});
