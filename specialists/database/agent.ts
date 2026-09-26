/**
 * Eve subagent slot for specialists/database.
 * Prompt body stays in `.cursor/agents/database.md`.
 */
import { defineSpecialist } from "../../agents/contract.js";

export const databaseSpecialist = defineSpecialist({
  id: "specialists/database",
  cursorNativeId: "database",
  cursorNativePath: ".cursor/agents/database.md",
  model: { selection: "orchestrator" },
  toolPolicy: {
    mode: "worktree_mutate",
    localTools: [],
    advancesWorkflow: false,
  },
});

export default databaseSpecialist;
