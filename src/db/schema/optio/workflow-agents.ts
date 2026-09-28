import { integer, primaryKey, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { optioSchema } from "./tenants.js";
import { workflows } from "./workflows.js";

export const workflowAgents = optioSchema.table(
  "workflow_agents",
  {
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.workflowId, t.agentId], name: "workflow_agents_pkey" })],
);
