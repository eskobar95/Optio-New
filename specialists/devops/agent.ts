/**
 * Eve subagent slot for specialists/devops.
 * Prompt body stays in `.cursor/agents/devops.md`.
 */
import { defineSpecialist } from "../../agents/contract.js";

export const devopsSpecialist = defineSpecialist({
  id: "specialists/devops",
  cursorNativeId: "devops",
  cursorNativePath: ".cursor/agents/devops.md",
  model: { selection: "orchestrator" },
  toolPolicy: {
    mode: "worktree_mutate",
    localTools: [],
    advancesWorkflow: false,
  },
});

export default devopsSpecialist;
