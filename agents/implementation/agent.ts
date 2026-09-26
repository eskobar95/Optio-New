/**
 * Optio-New — implementation phase agent (Eve slot).
 * Codes in the task worktree and may call specialist slots.
 */
import { definePhaseAgent } from "../contract.js";

export const agentId = "agents/implementation" as const;

export const implementationAgent = definePhaseAgent({
  id: agentId,
  phase: "implementation",
  model: { selection: "orchestrator" },
  toolPolicy: {
    mode: "worktree_mutate",
    localTools: [],
    advancesWorkflow: false,
  },
  skills: {
    index: "skills/index.json",
    sourceOfTruth: ".cursor/skills",
    mode: "from_planner_selection",
    allowed: ["skills/implement", "skills/tdd", "skills/codebase-design", "skills/diagnosing-bugs"],
  },
  specialistsAllowed: [
    "specialists/front-end",
    "specialists/back-end",
    "specialists/devops",
    "specialists/database",
  ],
});

export default implementationAgent;
