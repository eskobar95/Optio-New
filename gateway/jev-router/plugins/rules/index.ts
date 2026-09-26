import { decideDeterministic } from "../../deterministic.js";
import type { JevRouter, RoutingDecision, RoutingState } from "../../types.js";

/** Deterministic rules-only router (no LLM). Fail closed on ambiguity. */
export const rulesRouter: JevRouter = {
  async decide(state: RoutingState): Promise<RoutingDecision> {
    return decideDeterministic(state, "rules");
  },
};

export default rulesRouter;
