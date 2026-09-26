/**
 * Canonical span names (SPEC §12.4).
 * Every span carries `task_id` and `worktree_id` (empty string when no worktree exists yet).
 */

export const CANONICAL_SPAN = {
  workflowStep: "workflow.step",
  agentRun: "agent.run",
  specialistCall: "specialist.call",
  skillLoad: "skill.load",
  jevDecision: "jev.decision",
  worktreeCreate: "worktree.create",
  worktreeRemove: "worktree.remove",
  intakeWebhook: "intake.webhook",
  gatePass: "gate.pass",
  gateFail: "gate.fail",
  sessionQueue: "session.queue",
} as const;

export type CanonicalSpanName = (typeof CANONICAL_SPAN)[keyof typeof CANONICAL_SPAN];

export function readStringField(input: unknown, key: string): string {
  if (!input || typeof input !== "object" || !(key in input)) return "";
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}
