import type { RouterDeps } from "../../deps.js";
import { decideViaSystemOne } from "../../systemone.js";
import type { JevRouter, RoutingDecision, RoutingState } from "../../types.js";

/**
 * Laya local decision service (optional Compose profile `laya`, port 8000 loopback).
 * Same `/v1/systemone` wire as hosted Jev. The model field is omitted unless
 * `LAYA_MODEL` names a checkpoint, so `laya.serve` can auto-select.
 */
const DEFAULT_LAYA = "http://127.0.0.1:8000";

export function resolveLayaBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.OPTIO_NEW_LAYA_URL?.trim() || env.LAYA_URL?.trim();
  return value || DEFAULT_LAYA;
}

function layaApiKey(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.OPTIO_NEW_LAYA_API_KEY || env.LAYA_API_KEY;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function createLayaRouter(deps: RouterDeps = {}): JevRouter {
  const env = deps.env ?? process.env;
  return {
    async decide(state: RoutingState): Promise<RoutingDecision> {
      const model = env.LAYA_MODEL?.trim();
      return decideViaSystemOne(resolveLayaBaseUrl(env), state, {
        fetchImpl: deps.fetchImpl,
        apiKey: layaApiKey(env),
        model: model || undefined,
      });
    },
  };
}

export const layaRouter = createLayaRouter();

export default layaRouter;
