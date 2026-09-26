/**
 * Hop 1 backend choice (SPEC §14.4).
 * Rules plugin for v0. A DecisionAdvisor may break ties; it cannot spend a
 * closed quota or override force_deny / budget exhaustion. Fail closed.
 */
import { confidentChoice, consultAdvisor } from "./advisor.js";
import type {
  DecisionAdvisor,
  Hop1Choice,
  ModelRouter,
  RouteModelDecision,
  RouteModelInput,
} from "./types.js";

const HOP1: readonly Hop1Choice[] = ["cursor_subscription", "codex_gateway", "deny"];

function quotaClosed(remaining: number | undefined): boolean {
  return typeof remaining === "number" && remaining <= 0;
}

function budgetExhausted(input: RouteModelInput): boolean {
  if (typeof input.budget_usd_remaining === "number" && input.budget_usd_remaining <= 0) {
    return true;
  }
  return (
    typeof input.budget_usd_remaining === "number" &&
    typeof input.cost_estimate_usd === "number" &&
    input.cost_estimate_usd > input.budget_usd_remaining
  );
}

function decide(choice: Hop1Choice, reason: string, engine: "rules" | "jev"): RouteModelDecision {
  return {
    choice,
    reason,
    engine,
    confidence: engine === "jev" ? 0.9 : 1,
  };
}

export async function routeModel(
  input: RouteModelInput,
  advisor?: DecisionAdvisor | null,
): Promise<RouteModelDecision> {
  if (input.force_deny === true || budgetExhausted(input)) {
    return decide("deny", input.force_deny === true ? "force_deny" : "budget_exhausted", "rules");
  }

  const cursorClosed = quotaClosed(input.cursor_quota_remaining);
  const codexClosed = quotaClosed(input.codex_quota_remaining);

  if (input.coding_backend === "cursor") {
    return cursorClosed
      ? decide("deny", "quota_exhausted", "rules")
      : decide("cursor_subscription", "coding_backend_override", "rules");
  }
  if (input.coding_backend === "codex") {
    return codexClosed
      ? decide("deny", "quota_exhausted", "rules")
      : decide("codex_gateway", "coding_backend_override", "rules");
  }

  const advice = confidentChoice(await consultAdvisor(advisor, "route_model", input), HOP1);
  if (advice === "deny") return decide("deny", "advisor", "jev");
  if (advice === "cursor_subscription" && !cursorClosed) {
    return decide("cursor_subscription", "advisor", "jev");
  }
  if (advice === "codex_gateway" && !codexClosed) {
    return decide("codex_gateway", "advisor", "jev");
  }

  const cursorOpen = (input.cursor_quota_remaining ?? 0) > 0;
  const codexOpen = (input.codex_quota_remaining ?? 0) > 0;
  if (cursorOpen && codexOpen)
    return decide("cursor_subscription", "rules_default_cursor", "rules");
  if (cursorOpen) return decide("cursor_subscription", "rules_only_cursor", "rules");
  if (codexOpen) return decide("codex_gateway", "rules_only_codex", "rules");
  return decide("deny", "undecided", "rules");
}

/** Rules plugin. Pass an advisor to let Jev break soft ties later. */
export function createModelRouter(advisor?: DecisionAdvisor | null): ModelRouter {
  return {
    route: (input) => routeModel(input, advisor),
  };
}
