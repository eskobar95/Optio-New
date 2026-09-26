import { describe, expect, it } from "vitest";
import { splitOrProceed } from "../../src/kit-harness/index.js";

describe("splitOrProceed", () => {
  it("proceeds for a small task", () => {
    const decision = splitOrProceed({
      title: "fix healthcheck",
      description: "Return 200 from /health.",
      estimated_files: 2,
      estimated_steps: 1,
    });
    expect(decision).toEqual({ action: "proceed", reason: "within_limits" });
  });

  it("splits when the file estimate is above the default of 8", () => {
    const atLimit = splitOrProceed({ estimated_files: 8 });
    expect(atLimit.action).toBe("proceed");

    const over = splitOrProceed({ title: "wide", estimated_files: 9 });
    expect(over.action).toBe("split");
    expect(over.reason).toBe("estimated_files");
    expect(over.subtasks?.length).toBe(3);
    expect(over.subtasks?.[0]?.title).toContain("wide");
  });

  it("splits when the step estimate is above 5", () => {
    const decision = splitOrProceed({ estimated_steps: 6, estimated_files: 1 });
    expect(decision).toMatchObject({ action: "split", reason: "estimated_steps" });
  });

  it("splits on a known signal and ignores unknown signals", () => {
    const noise = splitOrProceed({ signals: ["nice-to-have"], estimated_files: 1 });
    expect(noise.action).toBe("proceed");

    const decision = splitOrProceed({ signals: ["schema_and_ui", "schema_and_ui"] });
    expect(decision.action).toBe("split");
    expect(decision.reason).toBe("signal");
    expect(decision.subtasks).toHaveLength(1);
    expect(decision.subtasks?.[0]?.title).toContain("schema");
  });

  it("splits a description that already lists three parts", () => {
    const decision = splitOrProceed({
      title: "factory",
      estimated_files: 1,
      description: ["- add route", "- add gate", "- add tests", "- write docs"].join("\n"),
    });
    expect(decision.reason).toBe("bullet_list");
    expect(decision.subtasks?.map((item) => item.title)).toEqual([
      "add route",
      "add gate",
      "add tests",
      "write docs",
    ]);
  });
});
