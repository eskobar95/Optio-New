import { boolean, jsonb, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { connectionKindEnum, optioSchema } from "./tenants.js";
import { workspaces } from "./workspaces.js";

/**
 * Connection configs (github | linear | slack | mcp).
 * Credentials live in Infisical — only path refs in DB.
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

/** Which agents may use a workspace connection. */
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
