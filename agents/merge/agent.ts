/**
 * Optio-New — merge phase agent (Eve slot).
 * Merges into development only when policy and CI allow. Orchestrator reaps the worktree.
 */
import { definePhaseAgent } from "../contract.js";

export const agentId = "agents/merge" as const;

export const mergeAgent = definePhaseAgent({
  id: agentId,
  phase: "merge",
  model: { selection: "orchestrator" },
  toolPolicy: {
    mode: "merge_only",
    localTools: [],
    advancesWorkflow: false,
  },
  skills: {
    index: "skills/index.json",
    sourceOfTruth: ".cursor/skills",
    mode: "fixed",
    allowed: ["skills/land", "skills/reap-worktree"],
  },
  specialistsAllowed: [],
  gates: {
    entry: ["ci_green", "merge_policy_allow", "pr_safety"],
    exit: ["merged_into_development"],
    onSuccess: "delete_worktree",
  },
});

export default mergeAgent;
