/**
 * Opt-in Jev plan gate helpers (ENG-25 gate #2).
 * Runnable TS lives here; docs pointer: orchestrator/jev/README.md.
 */
export {
  PlanGateTimeoutError,
  applyPlanGate,
  evaluatePlanWithGate,
  type PlanGateAction,
  type PlanGateDecision,
  type PlanGateLogEntry,
  type PlanGateLogFn,
} from "./plan-gate.js";
