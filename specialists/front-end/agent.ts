/**
 * Eve subagent slot for specialists/front-end.
 * Prompt body stays in `.cursor/agents/frontend.md`.
 */
import { defineSpecialist } from "../../agents/contract.js";

export const frontEndSpecialist = defineSpecialist({
  id: "specialists/front-end",
  cursorNativeId: "frontend",
  cursorNativePath: ".cursor/agents/frontend.md",
  model: { selection: "orchestrator" },
  toolPolicy: {
    mode: "worktree_mutate",
    localTools: [],
    advancesWorkflow: false,
  },
});

export default frontEndSpecialist;
