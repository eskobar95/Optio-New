import { describe, expect, it } from "vitest";
import {
  FLUE_IMPLEMENT_BINDING_STAGE,
  InMemoryFlueSessionBindingStore,
} from "../src/adapters/flue/session-binding.js";
import {
  DEFAULT_RETRY_MAX_ATTEMPTS,
  InMemoryWorkflowGateStore,
  WorkflowGateError,
  createPassthroughJevSmartRouting,
  evaluateConditional,
  evaluateRetry,
  evaluateSmartRouting,
  evaluateWorkflowGate,
  pauseApproval,
  resumeApproval,
  type JevSmartRoutingPort,
} from "../src/orchestrator/gates/index.js";

const DURABLE_ID = "flue-conv-eng-34";
const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function bindImplement(sessionBinding: InMemoryFlueSessionBindingStore, taskId = "t-gates"): void {
  sessionBinding.put({
    taskId,
    stage: FLUE_IMPLEMENT_BINDING_STAGE,
    flueSessionId: SESSION_ID,
    durableConversationId: DURABLE_ID,
  });
}

describe("approval gate", () => {
  it("pauses then approve resumes same Flue durableConversationId", () => {
    const store = new InMemoryWorkflowGateStore();
    const sessionBinding = new InMemoryFlueSessionBindingStore();
    bindImplement(sessionBinding);

    const paused = pauseApproval({ taskId: "t-gates", gateId: "g-approve", store });
    expect(paused.outcome).toBe("paused");
    expect(store.getApproval("t-gates", "g-approve")?.status).toBe("pending");

    const resumed = resumeApproval({
      taskId: "t-gates",
      gateId: "g-approve",
      action: "approve",
      store,
      sessionBinding,
    });
    expect(resumed).toEqual({
      kind: "approval",
      outcome: "approved",
      taskId: "t-gates",
      gateId: "g-approve",
      action: "continue",
      durableConversationId: DURABLE_ID,
    });
    expect(store.getApproval("t-gates", "g-approve")?.status).toBe("approved");
  });

  it("reject stops but preserves Flue binding", () => {
    const store = new InMemoryWorkflowGateStore();
    const sessionBinding = new InMemoryFlueSessionBindingStore();
    bindImplement(sessionBinding);
    pauseApproval({ taskId: "t-gates", gateId: "g-reject", store });

    const resumed = resumeApproval({
      taskId: "t-gates",
      gateId: "g-reject",
      action: "reject",
      store,
      sessionBinding,
    });
    expect(resumed.outcome).toBe("rejected");
    if (resumed.outcome !== "rejected") throw new Error("expected rejected");
    expect(resumed.action).toBe("stop");
    expect(resumed.durableConversationId).toBe(DURABLE_ID);
    expect(sessionBinding.get("t-gates", FLUE_IMPLEMENT_BINDING_STAGE)?.durableConversationId).toBe(
      DURABLE_ID,
    );
  });

  it("send_back appends feedback and returns same durableConversationId", () => {
    const store = new InMemoryWorkflowGateStore();
    const sessionBinding = new InMemoryFlueSessionBindingStore();
    bindImplement(sessionBinding);
    pauseApproval({ taskId: "t-gates", gateId: "g-send", store });

    const resumed = resumeApproval({
      taskId: "t-gates",
      gateId: "g-send",
      action: "send_back",
      comment: "fix the failing test",
      store,
      sessionBinding,
    });
    expect(resumed.outcome).toBe("send_back");
    if (resumed.outcome !== "send_back") throw new Error("expected send_back");
    expect(resumed.durableConversationId).toBe(DURABLE_ID);
    expect(resumed.comment).toBe("fix the failing test");

    const binding = sessionBinding.get("t-gates", FLUE_IMPLEMENT_BINDING_STAGE);
    expect(binding?.feedback).toHaveLength(1);
    expect(binding?.feedback[0]?.summary).toBe("fix the failing test");
    expect(binding?.feedback[0]?.verdict).toBe("send_back");
    expect(binding?.durableConversationId).toBe(DURABLE_ID);
  });

  it("resume without Flue binding fails closed", () => {
    const store = new InMemoryWorkflowGateStore();
    const sessionBinding = new InMemoryFlueSessionBindingStore();
    pauseApproval({ taskId: "t-orphan", gateId: "g-orphan", store });

    expect(() =>
      resumeApproval({
        taskId: "t-orphan",
        gateId: "g-orphan",
        action: "approve",
        store,
        sessionBinding,
      }),
    ).toThrow(WorkflowGateError);

    try {
      resumeApproval({
        taskId: "t-orphan",
        gateId: "g-orphan",
        action: "approve",
        store,
        sessionBinding,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowGateError);
      expect((err as WorkflowGateError).code).toBe("missing_flue_binding");
    }
  });
});

describe("conditional gate", () => {
  it("ci_status preset pass/fail", () => {
    expect(
      evaluateConditional({
        config: { preset: "ci_status" },
        evidence: { ciStatus: "success" },
      }).outcome,
    ).toBe("pass");
    expect(
      evaluateConditional({
        config: { preset: "ci_status" },
        evidence: { ciStatus: "failure" },
      }).outcome,
    ).toBe("fail");
  });

  it("conflict_check preset pass/fail", () => {
    expect(
      evaluateConditional({
        config: { preset: "conflict_check" },
        evidence: { hasConflict: false },
      }).outcome,
    ).toBe("pass");
    expect(
      evaluateConditional({
        config: { preset: "conflict_check" },
        evidence: { hasConflict: true },
      }).outcome,
    ).toBe("fail");
  });

  it("coverage_threshold preset", () => {
    expect(
      evaluateConditional({
        config: { preset: "coverage_threshold", coverageMinPercent: 80 },
        evidence: { coveragePercent: 85 },
      }).outcome,
    ).toBe("pass");
    expect(
      evaluateConditional({
        config: { preset: "coverage_threshold", coverageMinPercent: 80 },
        evidence: { coveragePercent: 70 },
      }).outcome,
    ).toBe("fail");
  });
});

describe("retry gate", () => {
  it("retries under max with accumulated Flue feedback", () => {
    const store = new InMemoryWorkflowGateStore();
    const sessionBinding = new InMemoryFlueSessionBindingStore();
    bindImplement(sessionBinding);

    const first = evaluateRetry({
      taskId: "t-gates",
      gateId: "g-retry",
      lastError: "tests failed",
      store,
      sessionBinding,
    });
    expect(first.outcome).toBe("retry");
    if (first.outcome !== "retry") throw new Error("expected retry");
    expect(first.attempt).toBe(1);
    expect(first.maxAttempts).toBe(DEFAULT_RETRY_MAX_ATTEMPTS);
    expect(first.lastError).toBe("tests failed");
    expect(first.durableConversationId).toBe(DURABLE_ID);

    const row = store.getRetry("t-gates", "g-retry");
    expect(row?.attempt).toBe(1);
    expect(row?.lastError).toBe("tests failed");

    const binding = sessionBinding.get("t-gates", FLUE_IMPLEMENT_BINDING_STAGE);
    expect(binding?.feedback).toHaveLength(1);
    expect(binding?.feedback[0]?.verdict).toBe("retry");
    expect(binding?.durableConversationId).toBe(DURABLE_ID);
  });

  it("exhausts after maxAttempts", () => {
    const store = new InMemoryWorkflowGateStore();
    const sessionBinding = new InMemoryFlueSessionBindingStore();
    bindImplement(sessionBinding);
    const config = { maxAttempts: 3 };

    for (let i = 0; i < 3; i += 1) {
      const result = evaluateRetry({
        taskId: "t-gates",
        gateId: "g-exhaust",
        lastError: `err-${i + 1}`,
        config,
        store,
        sessionBinding,
      });
      expect(result.outcome).toBe("retry");
    }

    const exhausted = evaluateRetry({
      taskId: "t-gates",
      gateId: "g-exhaust",
      lastError: "err-4",
      config,
      store,
      sessionBinding,
    });
    expect(exhausted.outcome).toBe("exhausted");
    if (exhausted.outcome !== "exhausted") throw new Error("expected exhausted");
    expect(exhausted.attempt).toBe(4);
    expect(exhausted.action).toBe("escalate");
    expect(exhausted.lastError).toBe("err-4");
    expect(store.getRetry("t-gates", "g-exhaust")?.lastError).toBe("err-4");
  });
});

describe("smart routing gate", () => {
  it("passthrough stub routes auto_continue", async () => {
    const result = await evaluateSmartRouting({
      input: { taskId: "t-1", stage: "implement", labels: [] },
      router: createPassthroughJevSmartRouting(),
    });
    expect(result).toEqual({
      kind: "smart_routing",
      outcome: "route",
      path: "auto_continue",
      reason: "passthrough_stub",
    });
  });

  it("fail-opens to auto_continue when port throws", async () => {
    const exploding: JevSmartRoutingPort = {
      async route() {
        throw new Error("jev down");
      },
    };
    const result = await evaluateSmartRouting({
      input: { taskId: "t-1", stage: "review", labels: ["p0"] },
      router: exploding,
    });
    expect(result.path).toBe("auto_continue");
    expect(result.reason).toBe("smart_routing_fail_open");
  });

  it("injected port can choose human_review", async () => {
    const human: JevSmartRoutingPort = {
      async route() {
        return { path: "human_review", reason: "high_priority" };
      },
    };
    const result = await evaluateSmartRouting({
      input: { taskId: "t-1", stage: "review", priority: "urgent", labels: [] },
      router: human,
    });
    expect(result.path).toBe("human_review");
    expect(result.reason).toBe("high_priority");
  });
});

describe("evaluateWorkflowGate dispatcher", () => {
  it("dispatches approval pause/resume and conditional", async () => {
    const store = new InMemoryWorkflowGateStore();
    const sessionBinding = new InMemoryFlueSessionBindingStore();
    bindImplement(sessionBinding);
    const deps = { store, sessionBinding };

    const paused = await evaluateWorkflowGate(
      { kind: "approval", taskId: "t-gates", gateId: "g-disp" },
      deps,
    );
    expect(paused.outcome).toBe("paused");

    const approved = await evaluateWorkflowGate(
      { kind: "approval", taskId: "t-gates", gateId: "g-disp", action: "approve" },
      deps,
    );
    expect(approved.outcome).toBe("approved");

    const conditional = await evaluateWorkflowGate(
      {
        kind: "conditional",
        config: { preset: "ci_status" },
        evidence: { ciStatus: "success" },
      },
      deps,
    );
    expect(conditional.outcome).toBe("pass");
  });
});
