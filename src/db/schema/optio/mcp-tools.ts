import { boolean, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { optioSchema } from "./tenants.js";
import { skills } from "./skills.js";
import { workspaces } from "./workspaces.js";

/**
 * MCP tool catalog entries — **capabilities**, not integrations (ADR-0002 / ENG-35).
 * Form-builder toggles these under Capabilities; GitHub/Linear/Slack stay on
 * `connections` at workflow/workspace level.
 */
export const mcpTools = optioSchema.table(
  "mcp_tools",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    /** Non-secret endpoint / server locator (URLs, command stubs). */
    endpoint: text("endpoint").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("mcp_tools_workspace_id_slug_unique").on(t.workspaceId, t.slug)],
);

/** Agent → MCP capability allow-list (node-level; not workflow integrations). */
export const agentMcpTools = optioSchema.table(
  "agent_mcp_tools",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    mcpToolId: uuid("mcp_tool_id")
      .notNull()
      .references(() => mcpTools.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.mcpToolId], name: "agent_mcp_tools_pkey" })],
);

/** Skill → MCP capability allow-list (same Capabilities UX as agents). */
export const skillMcpTools = optioSchema.table(
  "skill_mcp_tools",
  {
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    mcpToolId: uuid("mcp_tool_id")
      .notNull()
      .references(() => mcpTools.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.skillId, t.mcpToolId], name: "skill_mcp_tools_pkey" })],
);
