import { decideDeterministic } from "../../deterministic.js";
import type { JevRouter, RoutingDecision, RoutingState } from "../../types.js";

/**
 * Local lightweight router. Same budget and exact-cache rules as `rules`,
 * but a missing quota snapshot defaults to the subscription example model.
 */
export const poorjevRouter: JevRouter = {
  async decide(state: RoutingState): Promise<RoutingDecision> {
    return decideDeterministic(state, "poorjev");
  },
};

export default poorjevRouter;
