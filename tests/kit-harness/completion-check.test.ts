import { describe, expect, it } from "vitest";
import { checkCompletion } from "../../src/kit-harness/index.js";
import type { DecisionAdvisor } from "../../src/kit-harness/types.js";

const green = {
  tests_green: true,
  typecheck_green: true,
  lint_green: true,
  diff_present: true,
  ci_status: "success" as const,
};

describe("checkCompletion", () => {
  it("passes when the deterministic checks are green", async () => {
    const decision = await checkCompletion(green);
    expect(decision).toMatchObject({ verdict: "pass", reason: "checks_passed", engine: "rules" });
  });

  it("retries a failed test and fails once attempts are exhausted", async () => {
    const retry = await checkCompletion({ tests_green: false, attempt: 1, max_attempts: 3 });
    expect(retry).toMatchObject({ verdict: "retry", reason: "tests_failed", hard: false });

    const fail = await checkCompletion({ tests_green: false, attempt: 3, max_attempts: 3 });
    expect(fail).toMatchObject({ verdict: "fail", reason: "tests_failed", hard: true });
  });

  it("fails immediately on open blockers and does not ask the advisor", async () => {
    const calls = { n: 0 };
    const advisor: DecisionAdvisor = {
      async advise() {
        calls.n += 1;
        return { choice: "pass", confidence: 1 };
      },
    };
    const decision = await checkCompletion({ ...green, open_blockers: ["needs human"] }, advisor);
    expect(decision).toMatchObject({
      verdict: "fail",
      reason: "open_blockers",
      hard: true,
      engine: "rules",
    });
    expect(calls.n).toBe(0);
  });

  it("does not let the advisor turn a red test into a pass", async () => {
    const calls = { n: 0 };
    const advisor: DecisionAdvisor = {
      async advise() {
        calls.n += 1;
        return { choice: "pass", confidence: 1 };
      },
    };
    const decision = await checkCompletion({ tests_green: false, attempt: 1 }, advisor);
    expect(decision.verdict).toBe("retry");
    expect(calls.n).toBe(0);
  });

  it("retries while CI is pending and when evidence is missing", async () => {
    const pending = await checkCompletion({ ...green, ci_status: "pending", attempt: 1 });
    expect(pending).toMatchObject({ verdict: "retry", reason: "ci_pending" });

    const missing = await checkCompletion({ attempt: 2, max_attempts: 3 });
    expect(missing).toMatchObject({ verdict: "retry", reason: "evidence_incomplete" });
  });

  it("treats a missing diff and a failed typecheck as not done", async () => {
    const diff = await checkCompletion({ ...green, diff_present: false, attempt: 1 });
    expect(diff.reason).toBe("no_diff");
    const typecheck = await checkCompletion({ ...green, typecheck_green: false, attempt: 1 });
    expect(typecheck.reason).toBe("typecheck_failed");
  });

  it("lets a confident advisor downgrade a pass to retry", async () => {
    const advisor: DecisionAdvisor = {
      async advise(input) {
        expect(input.kind).toBe("completion");
        return { choice: "retry", confidence: 0.91, reason: "mock" };
      },
    };
    const decision = await checkCompletion(green, advisor);
    expect(decision).toMatchObject({
      verdict: "retry",
      reason: "advisor",
      engine: "jev",
      hard: false,
    });
  });
});
