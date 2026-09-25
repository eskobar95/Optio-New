import type { JevRouter, RoutingDecision, RoutingState } from "../../types.js";

/** Local/lightweight Jev-compatible stub. */
export const poorjevRouter: JevRouter = {
  async decide(_state: RoutingState): Promise<RoutingDecision> {
    throw new Error("gateway/jev-router/plugins/poorjev: not implemented (skeleton stub)");
  },
};

export default poorjevRouter;
