import type { JevRouter, RoutingDecision, RoutingState } from "../../types.js";

/** Deterministic rules-only router (no LLM). Fail closed on ambiguity. */
export const rulesRouter: JevRouter = {
  async decide(_state: RoutingState): Promise<RoutingDecision> {
    throw new Error("gateway/jev-router/plugins/rules: not implemented (skeleton stub)");
  },
};

export default rulesRouter;
