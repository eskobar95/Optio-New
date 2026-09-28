/**
 * Smart routing workflow gate (ENG-34).
 * Injectable Jev port stub — real skill-pick / HTTP stays ENG-25.
 */

import {
  SmartRoutingConfigSchema,
  SmartRoutingInputSchema,
  type SmartRoutingConfig,
  type SmartRoutingGateResult,
  type SmartRoutingInput,
  type SmartRoutingResult,
} from "./types.js";

/**
 * Soft seam for path selection. Optio injects a stub or (later) ENG-25.
 */
export interface JevSmartRoutingPort {
  route(input: SmartRoutingInput): Promise<SmartRoutingResult>;
}

/** Default stub: always auto_continue (no network). ENG-25 replaces this. */
export function createPassthroughJevSmartRouting(): JevSmartRoutingPort {
  return {
    async route(_input: SmartRoutingInput): Promise<SmartRoutingResult> {
      return { path: "auto_continue", reason: "passthrough_stub" };
    },
  };
}

export interface EvaluateSmartRoutingInput {
  input: SmartRoutingInput;
  config?: SmartRoutingConfig;
  router?: JevSmartRoutingPort;
}

/**
 * Soft fail-open by default: port throw → auto_continue.
 * Mirrors Jev soft-gate semantics (ENG-25 / ENG-36 skill-pick fail-open).
 */
export async function evaluateSmartRouting(
  options: EvaluateSmartRoutingInput,
): Promise<SmartRoutingGateResult> {
  const config = SmartRoutingConfigSchema.parse(options.config ?? {});
  const input = SmartRoutingInputSchema.parse(options.input);
  const router = options.router ?? createPassthroughJevSmartRouting();

  try {
    const result = await router.route(input);
    return {
      kind: "smart_routing",
      outcome: "route",
      path: result.path,
      reason: result.reason ?? "routed",
    };
  } catch {
    if (config.failOpen === false) {
      throw new Error("smart_routing_port_failed");
    }
    return {
      kind: "smart_routing",
      outcome: "route",
      path: "auto_continue",
      reason: "smart_routing_fail_open",
    };
  }
}
