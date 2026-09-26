/**
 * Eve subagent slot for specialists/back-end.
 * Prompt body stays in `.cursor/agents/backend.md`.
 */
import { defineSpecialist } from "../../agents/contract.js";

export const backEndSpecialist = defineSpecialist({
  id: "specialists/back-end",
  cursorNativeId: "backend",
  cursorNativePath: ".cursor/agents/backend.md",
  model: { selection: "orchestrator" },
  toolPolicy: {
    mode: "worktree_mutate",
    localTools: [],
    advancesWorkflow: false,
  },
});

export default backEndSpecialist;
