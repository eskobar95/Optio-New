import { primaryKey, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { optioSchema } from "./tenants.js";

/**
 * Typed allow-list: which sub-agents an agent may invoke.
 * Prefer this over legacy `agents.subagents` jsonb (ENG-35).
 */
export const agentSubagents = optioSchema.table(
  "agent_subagents",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    subagentId: uuid("subagent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.subagentId], name: "agent_subagents_pkey" })],
);
