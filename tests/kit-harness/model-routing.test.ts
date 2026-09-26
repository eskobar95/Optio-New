import { describe, expect, it } from "vitest";
import { createModelRouter, routeModel } from "../../src/kit-harness/index.js";
import { ADVISOR_CONFIDENCE_MIN, type DecisionAdvisor } from "../../src/kit-harness/types.js";

function advisor(choice: string, confidence: number, calls?: { n: number }): DecisionAdvisor {
  return {
    async advise() {
      if (calls) calls.n += 1;
      return { choice, confidence, reason: "mock" };
    },
  };
}

describe("routeModel", () => {
  it("honors a cursor coding_backend override", async () => {
    const decision = await routeModel({
      step_id: "implement",
      coding_backend: "cursor",
      cursor_quota_remaining: 2,
    });
    expect(decision).toMatchObject({
      choice: "cursor_subscription",
      reason: "coding_backend_override",
      engine: "rules",
    });
  });

  it("denies a cursor override when the cursor quota is closed", async () => {
    const calls = { n: 0 };
    const decision = await routeModel(
      { coding_backend: "cursor", cursor_quota_remaining: 0 },
      advisor("cursor_subscription", 1, calls),
    );
    expect(decision).toMatchObject({ choice: "deny", reason: "quota_exhausted", engine: "rules" });
    expect(calls.n).toBe(0);
  });

  it("denies when the budget is already spent", async () => {
    const calls = { n: 0 };
    const decision = await routeModel(
      { budget_usd_remaining: 0, cursor_quota_remaining: 5, force_deny: false },
      advisor("codex_gateway", 1, calls),
    );
    expect(decision).toMatchObject({ choice: "deny", reason: "budget_exhausted", engine: "rules" });
    expect(calls.n).toBe(0);
  });

  it("denies when the estimate exceeds the remaining budget", async () => {
    const decision = await routeModel({
      budget_usd_remaining: 1,
      cost_estimate_usd: 2,
      codex_quota_remaining: 3,
    });
    expect(decision.choice).toBe("deny");
    expect(decision.reason).toBe("budget_exhausted");
  });

  it("fails closed with no override and no open quota", async () => {
    const decision = await routeModel({ step_id: "implement", task_id: "t-1" });
    expect(decision).toMatchObject({ choice: "deny", reason: "undecided", engine: "rules" });
  });

  it("picks the only open quota", async () => {
    const decision = await routeModel({ codex_quota_remaining: 1, cursor_quota_remaining: 0 });
    expect(decision).toMatchObject({ choice: "codex_gateway", reason: "rules_only_codex" });
  });

  it("defaults to cursor when both quotas are open", async () => {
    const decision = await routeModel({
      cursor_quota_remaining: 1,
      codex_quota_remaining: 1,
    });
    expect(decision).toMatchObject({
      choice: "cursor_subscription",
      reason: "rules_default_cursor",
      engine: "rules",
    });
  });

  it("lets a confident advisor break a tie", async () => {
    const decision = await routeModel(
      { cursor_quota_remaining: 2, codex_quota_remaining: 2 },
      advisor("codex_gateway", ADVISOR_CONFIDENCE_MIN),
    );
    expect(decision).toMatchObject({
      choice: "codex_gateway",
      reason: "advisor",
      engine: "jev",
    });
  });

  it("ignores a low-confidence advisor and an advisor that throws", async () => {
    const low = await routeModel(
      { cursor_quota_remaining: 1, codex_quota_remaining: 1 },
      advisor("codex_gateway", ADVISOR_CONFIDENCE_MIN - 0.01),
    );
    expect(low.choice).toBe("cursor_subscription");
    expect(low.engine).toBe("rules");

    const throwing: DecisionAdvisor = {
      async advise() {
        throw new Error("jev down");
      },
    };
    const fallen = await routeModel({ codex_quota_remaining: 2 }, throwing);
    expect(fallen).toMatchObject({ choice: "codex_gateway", engine: "rules" });
  });

  it("does not let the advisor spend a closed quota", async () => {
    const decision = await routeModel(
      { cursor_quota_remaining: 0, codex_quota_remaining: 0 },
      advisor("cursor_subscription", 0.99),
    );
    expect(decision).toMatchObject({ choice: "deny", reason: "undecided", engine: "rules" });
  });

  it("createModelRouter delegates to the same rules", async () => {
    const router = createModelRouter();
    const decision = await router.route({ coding_backend: "codex", codex_quota_remaining: 1 });
    expect(decision.choice).toBe("codex_gateway");
  });
});
