/**
 * Optio-New — planner phase agent (Eve slot).
 * Plan + skill/specialist selection. Does not write code or open PRs.
 */
import { definePhaseAgent } from "../contract.js";

export const agentId = "agents/planner" as const;

export const plannerAgent = definePhaseAgent({
  id: agentId,
  phase: "planner",
  model: { selection: "orchestrator" },
  toolPolicy: {
    mode: "read_only",
    localTools: [],
    advancesWorkflow: false,
  },
  skills: {
    index: "skills/index.json",
    sourceOfTruth: ".cursor/skills",
    mode: "fixed",
    allowed: ["skills/_shared", "skills/bot-session"],
  },
  specialistsAllowed: [],
  gates: {
    entry: ["session_acked"],
    exit: ["plan_present", "jev_route_ok"],
    onFail: "escalate_bot",
  },
});

export default plannerAgent;
