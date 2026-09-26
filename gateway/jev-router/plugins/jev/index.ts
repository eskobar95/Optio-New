import type { RouterDeps } from "../../deps.js";
import { decideViaSystemOne } from "../../systemone.js";
import type { JevRouter, RoutingDecision, RoutingState } from "../../types.js";

/**
 * Hosted Jev via Vercel AI Gateway (v1 temporary path while TypeSafe signup is paused).
 * Base URL from env — the plugin appends `/v1/systemone`. Not TypeSafe direct.
 */
const DEFAULT_GATEWAY = "https://ai-gateway.vercel.sh";

export function resolveJevBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const read = (key: string): string | undefined => {
    const value = env[key];
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };
  return (
    read("OPTIO_NEW_JEV_BASE_URL") ||
    read("JEV_BASE_URL") ||
    read("OPTIO_NEW_VERCEL_AI_GATEWAY_URL") ||
    read("VERCEL_AI_GATEWAY_URL") ||
    DEFAULT_GATEWAY
  );
}

function jevApiKey(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.OPTIO_NEW_JEV_API_KEY || env.JEV_API_KEY;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function createJevRouter(deps: RouterDeps = {}): JevRouter {
  const env = deps.env ?? process.env;
  return {
    async decide(state: RoutingState): Promise<RoutingDecision> {
      const model = env.JEV_MODEL?.trim() || "jev-latest";
      return decideViaSystemOne(resolveJevBaseUrl(env), state, {
        fetchImpl: deps.fetchImpl,
        apiKey: jevApiKey(env),
        model,
      });
    },
  };
}

export const jevRouter = createJevRouter();

export default jevRouter;
