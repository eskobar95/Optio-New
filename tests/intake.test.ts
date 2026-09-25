import { describe, it, expect } from "vitest";
import { buildIntakeJob, processHelloWorld } from "../src/index.js";

describe("optio-new intake → hello-world", () => {
  it("builds a valid intake job", () => {
    const job = buildIntakeJob({
      taskId: "t-1",
      title: "hello",
      description: "smoke",
    });
    expect(job.taskId).toBe("t-1");
    expect(job.title).toBe("hello");
  });

  it("acks hello-world processor", async () => {
    const result = await processHelloWorld("t-1");
    expect(result).toEqual({ ok: true, taskId: "t-1" });
  });
});
