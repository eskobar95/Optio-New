import { boolean, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { optioSchema, sandboxModeEnum } from "./tenants.js";
import { workspaces } from "./workspaces.js";

export const agents = optioSchema.table("agents", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** Agent role/kind (planner, implementation, specialist, …) — open set. */
  kind: text("kind").notNull(),
  /** Path or id pointing at instructions SoT — not inline body. */
  instructionsRef: text("instructions_ref").notNull(),
  /** Model id for Flue/agent runtime (not Cursor session model). */
  model: text("model"),
  /** Sandbox mode — v1 `local` only; Docker sandbox deferred. */
  sandboxMode: sandboxModeEnum("sandbox_mode").notNull().default("local"),
  /** Tool allowlist / refs (non-secret). */
  tools: jsonb("tools").$type<unknown[]>().notNull().default([]),
  /** Nested specialist/subagent refs. */
  subagents: jsonb("subagents").$type<unknown[]>().notNull().default([]),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
