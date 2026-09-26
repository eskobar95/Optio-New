/**
 * Advisor consultation. Failures fall back to the rules engine.
 * v0 has no HTTP client — callers pass a DecisionAdvisor or nothing.
 */
import { ADVISOR_CONFIDENCE_MIN, type AdvisorResult, type DecisionAdvisor } from "./types.js";

export async function consultAdvisor(
  advisor: DecisionAdvisor | null | undefined,
  kind: "route_model" | "tool_gate" | "completion",
  payload: unknown,
): Promise<AdvisorResult | null> {
  if (!advisor) return null;
  try {
    return await advisor.advise({ kind, payload });
  } catch {
    return null;
  }
}

export function confidentChoice(
  result: AdvisorResult | null,
  allowed: readonly string[],
): string | null {
  if (!result?.choice) return null;
  if ((result.confidence ?? 0) < ADVISOR_CONFIDENCE_MIN) return null;
  return allowed.includes(result.choice) ? result.choice : null;
}
