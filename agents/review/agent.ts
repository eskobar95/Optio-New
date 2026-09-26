/**
 * Optio-New — review phase agent (Eve slot).
 * Reads the diff and returns pass/fail. Does not merge.
 */
import { definePhaseAgent } from "../contract.js";

export const agentId = "agents/review" as const;

export const reviewAgent = definePhaseAgent({
  id: agentId,
  phase: "review",
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
    allowed: ["skills/code-review"],
  },
  specialistsAllowed: [],
});

export default reviewAgent;
