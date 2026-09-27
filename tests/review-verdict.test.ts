import { describe, expect, it } from "vitest";
import { landAtMergeGate } from "../src/orchestrator/linear/land.js";
import {
  hannesFeedbackComment,
  parseReviewVerdict,
} from "../src/orchestrator/linear/review-verdict.js";

describe("Hannes verdict", () => {
  it("fails closed when the agent omits the verdict line", () => {
    const verdict = parseReviewVerdict("Looks fine to me.");
    expect(verdict.verdict).toBe("fail");
    expect(verdict.expected).toBe("Fix the named files.");
  });

  it("uses the last verdict and keeps the handoff fields short", () => {
    const verdict = parseReviewVerdict(
      [
        "OPTIO_REVIEW_VERDICT pass",
        "OPTIO_REVIEW_VERDICT fail",
        "Files: src/app.ts, src/gate.ts",
        "Standards: Duplicated Code",
        "Spec: missing land gate",
        "Slop: none",
        "Expected: call landAtMergeGate ghp_secretvalue",
      ].join("\n"),
    );
    expect(verdict.verdict).toBe("fail");
    expect(verdict.files).toEqual(["src/app.ts", "src/gate.ts"]);
    const comment = hannesFeedbackComment({ verdict, attempt: 1, escalateAfter: 3 });
    expect(comment).toContain("[review]");
    expect(comment).toContain("Files: src/app.ts, src/gate.ts");
    expect(comment).toContain("Expected: call landAtMergeGate");
    expect(comment).toContain("Attempt: 1/3");
    expect(comment).toContain("[REDACTED]");
    expect(comment).not.toContain("ghp_secretvalue");
  });

  it("passes only on an explicit pass line", () => {
    expect(parseReviewVerdict("OPTIO_REVIEW_VERDICT pass\nFiles: src/a.ts").verdict).toBe("pass");
  });
});

describe("land gate", () => {
  it("merges only when CI is green and the review is approved", () => {
    expect(landAtMergeGate({ ci: "green", reviewApproved: true })).toEqual({ ok: true });
    expect(landAtMergeGate({ ci: "red", reviewApproved: true })).toEqual({
      ok: false,
      reason: "ci_not_green",
    });
    expect(landAtMergeGate({ ci: "green", reviewApproved: false })).toEqual({
      ok: false,
      reason: "review_not_approved",
    });
    expect(landAtMergeGate({ reviewApproved: true })).toEqual({
      ok: false,
      reason: "ci_not_green",
    });
  });
});
