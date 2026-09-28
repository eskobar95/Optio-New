/**
 * Conditional workflow gate presets (ENG-34).
 * Pure evaluators — no network, no BullMQ side effects.
 */

import {
  ConditionalConfigSchema,
  ConditionalEvidenceSchema,
  WorkflowGateError,
  type ConditionalConfig,
  type ConditionalEvidence,
  type ConditionalGateResult,
} from "./types.js";

export interface EvaluateConditionalInput {
  config: ConditionalConfig;
  evidence: ConditionalEvidence;
}

/** Evaluate stage evidence against a conditional preset. */
export function evaluateConditional(input: EvaluateConditionalInput): ConditionalGateResult {
  const config = ConditionalConfigSchema.parse(input.config);
  const evidence = ConditionalEvidenceSchema.parse(input.evidence);

  switch (config.preset) {
    case "ci_status": {
      if (evidence.ciStatus === "success") {
        return {
          kind: "conditional",
          outcome: "pass",
          preset: "ci_status",
          reason: "ci_status_success",
        };
      }
      return {
        kind: "conditional",
        outcome: "fail",
        preset: "ci_status",
        reason: `ci_status_${evidence.ciStatus ?? "missing"}`,
      };
    }
    case "conflict_check": {
      if (evidence.hasConflict === true) {
        return {
          kind: "conditional",
          outcome: "fail",
          preset: "conflict_check",
          reason: "conflict_present",
        };
      }
      if (evidence.hasConflict === false) {
        return {
          kind: "conditional",
          outcome: "pass",
          preset: "conflict_check",
          reason: "no_conflict",
        };
      }
      return {
        kind: "conditional",
        outcome: "fail",
        preset: "conflict_check",
        reason: "conflict_unknown",
      };
    }
    case "coverage_threshold": {
      const min = config.coverageMinPercent;
      // Schema superRefine guarantees min; keep runtime guard for typed callers.
      if (min === undefined) {
        throw new WorkflowGateError(
          "invalid_config",
          "coverage_threshold requires coverageMinPercent",
        );
      }
      if (evidence.coveragePercent === undefined) {
        return {
          kind: "conditional",
          outcome: "fail",
          preset: "coverage_threshold",
          reason: "coverage_missing",
        };
      }
      if (evidence.coveragePercent >= min) {
        return {
          kind: "conditional",
          outcome: "pass",
          preset: "coverage_threshold",
          reason: `coverage_${evidence.coveragePercent}_gte_${min}`,
        };
      }
      return {
        kind: "conditional",
        outcome: "fail",
        preset: "coverage_threshold",
        reason: `coverage_${evidence.coveragePercent}_lt_${min}`,
      };
    }
    case "custom": {
      if (!config.customRuleId) {
        throw new WorkflowGateError("invalid_config", "custom preset requires customRuleId");
      }
      if (evidence.customPass === true) {
        return {
          kind: "conditional",
          outcome: "pass",
          preset: "custom",
          reason: `custom_${config.customRuleId}_pass`,
        };
      }
      return {
        kind: "conditional",
        outcome: "fail",
        preset: "custom",
        reason: `custom_${config.customRuleId}_fail`,
      };
    }
    default: {
      const _exhaustive: never = config.preset;
      throw new WorkflowGateError("unknown_kind", `Unknown conditional preset: ${_exhaustive}`);
    }
  }
}
