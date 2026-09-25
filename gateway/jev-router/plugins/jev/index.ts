import type { JevRouter, RoutingDecision, RoutingState } from "../../types.js";

/**
 * Hosted Jev via Vercel AI Gateway (v1 temporary path while TypeSafe signup is paused).
 * Base URL from env — NOT TypeSafe direct.
 */
const DEFAULT_GATEWAY = "https://ai-gateway.vercel.sh";

export function resolveJevBaseUrl(): string {
  return (
    process.env.OPTIO_NEW_JEV_BASE_URL ||
    process.env.JEV_BASE_URL ||
    process.env.OPTIO_NEW_VERCEL_AI_GATEWAY_URL ||
    process.env.VERCEL_AI_GATEWAY_URL ||
    DEFAULT_GATEWAY
  );
}

export const jevRouter: JevRouter = {
  async decide(_state: RoutingState): Promise<RoutingDecision> {
    const base = resolveJevBaseUrl();
    void base; // wire HTTP/MCP client in implementation
    throw new Error(`gateway/jev-router/plugins/jev: stub (base=${resolveJevBaseUrl()})`);
  },
};

export default jevRouter;
