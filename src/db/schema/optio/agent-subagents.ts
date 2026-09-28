import { sql } from "drizzle-orm";
import { check, primaryKey, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { optioSchema } from "./tenants.js";

/**
 * Typed allow-list: which sub-agents an agent may invoke.
 * Canonical over legacy `agents.subagents` jsonb (ENG-35).
 * Write-path must also enforce same `workspace_id` (no cross-workspace FK).
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
  (t) => [
    primaryKey({ columns: [t.agentId, t.subagentId], name: "agent_subagents_pkey" }),
    check("agent_subagents_no_self", sql`${t.agentId} <> ${t.subagentId}`),
  ],
);
