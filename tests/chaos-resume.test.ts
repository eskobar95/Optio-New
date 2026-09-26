import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { JsonFileStepCursorStore, readStageCheckpoint, runPipeline } from "../src/index.js";

const require = createRequire(import.meta.url);
const vitestEntry = require.resolve("vitest/vitest.mjs");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function waitForFile(file: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(file);
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return false;
}

describe("host chaos resume", () => {
  it("kills the orchestrator during implement and resumes the unfinished step", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "optio-chaos-"));
    dirs.push(dir);
    const cursorPath = path.join(dir, "cursor.json");
    const readyPath = path.join(dir, "ready");
    let stderr = "";
    const child = spawn(
      process.execPath,
      [vitestEntry, "run", "tests/chaos-resume.child.test.ts", "--pool=threads"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          OPTIO_CHAOS_CHILD: "1",
          OPTIO_CHAOS_CURSOR: cursorPath,
          OPTIO_CHAOS_READY: readyPath,
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000);
    });

    try {
      const ready = await waitForFile(readyPath, 60_000);
      if (!ready) {
        throw new Error(`chaos child did not reach implement: ${stderr}`);
      }
      child.kill("SIGKILL");
      const exitCode = await new Promise<number | null>((resolve) => {
        child.once("exit", (code) => resolve(code));
      });
      expect(exitCode).not.toBe(0);

      const cursors = new JsonFileStepCursorStore(cursorPath);
      await expect(readStageCheckpoint(cursors, "chaos-1", "chaos-1")).resolves.toEqual({
        taskId: "chaos-1",
        sessionId: "chaos-1",
        lastCompletedStage: "plan",
        resumeStage: "implement",
      });
      const calls: string[] = [];
      const resumed = await runPipeline(
        { taskId: "chaos-1", sessionId: "chaos-1" },
        {
          cursors,
          handler: {
            async run(ctx) {
              calls.push(`${ctx.stage}:${ctx.step}`);
            },
          },
        },
      );
      expect(calls[0]).toBe("implement:record_diff");
      expect(calls).not.toContain("plan:ack_session");
      expect(calls).not.toContain("implement:invoke_implementation");
      expect(resumed.stages.every((stage) => stage.status === "completed")).toBe(true);
    } finally {
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    }
  }, 90_000);
});
