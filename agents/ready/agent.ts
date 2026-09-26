/**
 * Optio-New — ready phase agent (Eve slot).
 * Opens or updates the PR and watches CI. Does not merge.
 */
import { definePhaseAgent } from "../contract.js";

export const agentId = "agents/ready" as const;

export const readyAgent = definePhaseAgent({
  id: agentId,
  phase: "ready",
  model: { selection: "orchestrator" },
  toolPolicy: {
    mode: "pr_only",
    localTools: [],
    advancesWorkflow: false,
  },
  skills: {
    index: "skills/index.json",
    sourceOfTruth: ".cursor/skills",
    mode: "fixed",
    allowed: ["skills/land", "skills/sync-development"],
  },
  specialistsAllowed: [],
  gates: {
    entry: ["review_pass", "pr_safety"],
    exit: ["pr_open", "ci_pending_or_green"],
    onFail: "escalate_bot",
  },
});

export default readyAgent;
