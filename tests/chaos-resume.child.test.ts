/**
 * Child process for the host chaos proof. Skipped unless OPTIO_CHAOS_CHILD=1.
 * The parent kills this process with SIGKILL while implement is inside record_diff.
 */
import { writeFile } from "node:fs/promises";
import { describe, it } from "vitest";
import { JsonFileStepCursorStore, processStageJob } from "../src/index.js";

const cursorPath = process.env.OPTIO_CHAOS_CURSOR;
const readyPath = process.env.OPTIO_CHAOS_READY;
const enabled = process.env.OPTIO_CHAOS_CHILD === "1" && Boolean(cursorPath) && Boolean(readyPath);

describe("chaos resume child", () => {
  it.skipIf(!enabled)(
    "hangs during implement record_diff until killed",
    async () => {
      const cursors = new JsonFileStepCursorStore(cursorPath ?? "");
      const identity = { taskId: "chaos-1", sessionId: "chaos-1" };
      await processStageJob(
        { ...identity, stage: "plan" },
        { cursors, handler: { async run() {} } },
      );
      await processStageJob(
        { ...identity, stage: "implement" },
        {
          cursors,
          handler: {
            async run(ctx) {
              if (ctx.step === "record_diff") {
                await writeFile(readyPath ?? "", "ready\n");
                await new Promise(() => undefined);
              }
            },
          },
        },
      );
    },
    120_000,
  );
});
