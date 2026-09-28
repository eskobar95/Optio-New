import { boolean, jsonb, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { connectionKindEnum, optioSchema } from "./tenants.js";
import { workflows } from "./workflows.js";
import { workspaces } from "./workspaces.js";

/**
 * Connection configs (github | linear | slack | mcp).
 * Credentials live in Infisical — only path refs in DB.
 *
 * ENG-35 / ADR-0002: GitHub/Linear/Slack are **workflow/workspace integrations**.
 * MCP **capabilities** live in `mcp_tools`; `kind=mcp` remains for vaulted MCP
 * server credentials (ENG-24 schema lock) — not for form-builder capability toggles.
 */
export const connections = optioSchema.table(
  "connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: connectionKindEnum("kind").notNull(),
    name: text("name").notNull(),
    /** Infisical secret path within the workspace environment. */
    infisicalSecretPath: text("infisical_secret_path").notNull(),
    /** Non-secret config (urls, scopes, mcp command stubs). */
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("connections_workspace_id_kind_name_unique").on(t.workspaceId, t.kind, t.name)],
);

/**
 * Agent allow-list of workspace integrations (github/linear/slack).
 * Prefer `agent_mcp_tools` for MCP capabilities (ADR-0002).
 */
export const agentConnections = optioSchema.table(
  "agent_connections",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.connectionId], name: "agent_connections_pkey" })],
);

/** Workflow-level binding to workspace integrations (GitHub / Linear / Slack). */
export const workflowConnections = optioSchema.table(
  "workflow_connections",
  {
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.workflowId, t.connectionId], name: "workflow_connections_pkey" }),
  ],
);
