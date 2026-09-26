import { describe, expect, it } from "vitest";
import { UnrecoverableError } from "bullmq";
import {
  InMemoryStepCursorStore,
  ReviewGateClosedError,
  evaluateReviewGate,
  processStageJob,
  type CompletionAdvisor,
  type ReviewGateEvidence,
} from "../src/index.js";

const green: ReviewGateEvidence = {
  tests_green: true,
  ci_status: "success",
};

const identity = { taskId: "t-1", sessionId: "s-1" };

function advisor(choice: string, confidence: number): CompletionAdvisor {
  return {
    async advise() {
      return { choice, confidence, reason: "mock" };
    },
  };
}

async function reviewCompleted(): Promise<InMemoryStepCursorStore> {
  const cursors = new InMemoryStepCursorStore();
  await cursors.save({
    taskId: identity.taskId,
    sessionId: identity.sessionId,
    stage: "review",
    nextStepIndex: 2,
    status: "completed",
    updatedAt: "2026-09-26T00:00:00.000Z",
  });
  return cursors;
}

describe("evaluateReviewGate", () => {
  it("fails closed without evidence and retries into rework", async () => {
    const missing = await evaluateReviewGate(undefined);
    expect(missing).toMatchObject({
      verdict: "retry",
      path: "rework",
      reason: "evidence_incomplete",
      hard: false,
      engine: "rules",
      attempt: 1,
      max_attempts: 3,
    });

    const empty = await evaluateReviewGate({});
    expect(empty).toMatchObject({
      verdict: "retry",
      path: "rework",
      reason: "evidence_incomplete",
    });
  });

  it("replans once the attempt budget is spent without evidence", async () => {
    const decision = await evaluateReviewGate({ attempt: 3, max_attempts: 3 });
    expect(decision).toMatchObject({
      verdict: "fail",
      path: "replan",
      reason: "evidence_incomplete",
      hard: true,
      engine: "rules",
    });
  });

  it("passes only when tests are green, CI succeeded, and the rules completion check passes", async () => {
    const decision = await evaluateReviewGate(green);
    expect(decision).toMatchObject({
      verdict: "pass",
      path: "ready",
      reason: "checks_passed",
      hard: false,
      engine: "rules",
    });
  });

  it("retries a red test into rework, then replans when retries are exhausted", async () => {
    const retry = await evaluateReviewGate({
      tests_green: false,
      ci_status: "success",
      attempt: 1,
    });
    expect(retry).toMatchObject({
      verdict: "retry",
      path: "rework",
      reason: "tests_failed",
      hard: false,
    });

    const fail = await evaluateReviewGate({
      tests_green: false,
      ci_status: "success",
      attempt: 3,
      max_attempts: 3,
    });
    expect(fail).toMatchObject({
      verdict: "fail",
      path: "replan",
      reason: "tests_failed",
      hard: true,
    });
  });

  it("keeps CI that is not green out of ready", async () => {
    const pending = await evaluateReviewGate({ ...green, ci_status: "pending", attempt: 1 });
    expect(pending).toMatchObject({ verdict: "retry", path: "rework", reason: "ci_pending" });

    const failed = await evaluateReviewGate({ ...green, ci_status: "failure", attempt: 2 });
    expect(failed).toMatchObject({ verdict: "retry", path: "rework", reason: "ci_failed" });

    const absent = await evaluateReviewGate({ tests_green: true, attempt: 1 });
    expect(absent).toMatchObject({
      verdict: "retry",
      path: "rework",
      reason: "evidence_incomplete",
    });
  });

  it("fails open blockers closed into replan and does not ask Jev", async () => {
    const calls = { n: 0 };
    const jev: CompletionAdvisor = {
      async advise() {
        calls.n += 1;
        return { choice: "pass", confidence: 1 };
      },
    };
    const decision = await evaluateReviewGate(
      { ...green, open_blockers: ["needs human"], review_notes: "blocker" },
      jev,
    );
    expect(decision).toMatchObject({
      verdict: "fail",
      path: "replan",
      reason: "open_blockers",
      hard: true,
      engine: "rules",
      review_notes: "blocker",
    });
    expect(calls.n).toBe(0);
  });

  it("does not let Jev turn a red test into a pass", async () => {
    const calls = { n: 0 };
    const jev: CompletionAdvisor = {
      async advise() {
        calls.n += 1;
        return { choice: "pass", confidence: 1 };
      },
    };
    const decision = await evaluateReviewGate({ tests_green: false, attempt: 1 }, jev);
    expect(decision.verdict).toBe("retry");
    expect(decision.path).toBe("rework");
    expect(calls.n).toBe(0);
  });

  it("lets a confident Jev downgrade a green check to rework or replan", async () => {
    const rework = await evaluateReviewGate(green, advisor("retry", 0.91));
    expect(rework).toMatchObject({
      verdict: "retry",
      path: "rework",
      reason: "advisor",
      engine: "jev",
      hard: false,
    });

    const replan = await evaluateReviewGate(green, advisor("fail", 0.91));
    expect(replan).toMatchObject({
      verdict: "fail",
      path: "replan",
      reason: "advisor",
      engine: "jev",
      hard: false,
    });

    const ignored = await evaluateReviewGate(green, advisor("fail", 0.2));
    expect(ignored).toMatchObject({ verdict: "pass", path: "ready", engine: "rules" });
  });

  it("keeps the rules pass when Jev throws", async () => {
    const jev: CompletionAdvisor = {
      async advise() {
        throw new Error("jev down");
      },
    };
    const decision = await evaluateReviewGate(green, jev);
    expect(decision).toMatchObject({ verdict: "pass", path: "ready", engine: "rules" });
  });
});

describe("ready stage review gate", () => {
  it("does not start ready when the gate has no evidence", async () => {
    const calls: string[] = [];
    const cursors = await reviewCompleted();
    await expect(
      processStageJob(
        { ...identity, stage: "ready" },
        {
          cursors,
          reviewGate: {
            async loadEvidence() {
              return undefined;
            },
          },
          handler: {
            async run(ctx) {
              calls.push(ctx.step);
            },
          },
        },
      ),
    ).rejects.toBeInstanceOf(ReviewGateClosedError);

    expect(calls).toEqual([]);
    expect(await cursors.get(identity.taskId, identity.sessionId, "ready")).toBeUndefined();
  });

  it("starts ready after a passing gate and carries rework on a failed retry", async () => {
    const calls: string[] = [];
    const passed = await processStageJob(
      { ...identity, stage: "ready" },
      {
        cursors: await reviewCompleted(),
        reviewGate: {
          async loadEvidence() {
            return green;
          },
        },
        handler: {
          async run(ctx) {
            calls.push(ctx.step);
          },
        },
      },
    );
    expect(passed.status).toBe("completed");
    expect(calls).toEqual(["open_pr", "record_ci_wait"]);

    const blocked = await processStageJob(
      { ...identity, stage: "ready" },
      {
        cursors: await reviewCompleted(),
        reviewGate: {
          async loadEvidence() {
            return {
              tests_green: false,
              ci_status: "failure",
              attempt: 1,
              review_notes: "fix tests",
            };
          },
        },
        handler: {
          async run() {
            throw new Error("ready must not run");
          },
        },
      },
    ).catch((error: unknown) => error);

    expect(blocked).toBeInstanceOf(UnrecoverableError);
    expect(blocked).toBeInstanceOf(ReviewGateClosedError);
    expect(blocked).toMatchObject({
      decision: {
        verdict: "retry",
        path: "rework",
        reason: "tests_failed",
        review_notes: "fix tests",
      },
    });
  });
});
