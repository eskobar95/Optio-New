import type { DecisionSidecar, SidecarAdvice, ToolCallRequest } from "./types.js";

/**
 * Passthrough stand-in for the kit-harness decision sidecar.
 * Hard gates never call this after a deny, so an allow here cannot unlock secrets or config.
 */
export function createStubDecisionSidecar(): DecisionSidecar {
  return {
    async advise(_request: ToolCallRequest): Promise<SidecarAdvice> {
      return { verdict: "allow", reason: "kit_harness_sidecar_stub" };
    },
  };
}
