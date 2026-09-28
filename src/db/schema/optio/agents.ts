import { boolean, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { optioSchema, sandboxModeEnum } from "./tenants.js";
import { workspaces } from "./workspaces.js";

export const agents = optioSchema.table("agents", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** Catalog identity (lazy-load: name+description first; body on select). */
  description: text("description"),
  /** Agent role/kind (planner, implementation, specialist, subagent, …) — open set. */
  kind: text("kind").notNull(),
  /** Path or id pointing at instructions SoT (Markdown) — not inline body. */
  instructionsRef: text("instructions_ref").notNull(),
  /** Path to YAML config SoT (form-builder ↔ raw toggle). */
  configRef: text("config_ref"),
  /** Model id for Flue/agent runtime (not Cursor session model). */
  model: text("model"),
  /** Sandbox mode — v1 `local` only; Docker sandbox deferred. */
  sandboxMode: sandboxModeEnum("sandbox_mode").notNull().default("local"),
  /**
   * Legacy tool allowlist / refs (non-secret). Prefer `agent_mcp_tools` +
   * `agent_skills` / `agent_subagents` for ENG-35 allow-lists.
   */
  tools: jsonb("tools").$type<unknown[]>().notNull().default([]),
  /**
   * Legacy nested specialist/subagent refs. Prefer `agent_subagents` join
   * for typed allow-list bindings.
   */
  subagents: jsonb("subagents").$type<unknown[]>().notNull().default([]),
  /** When true, load catalog fields only until select / Jev pick (ADR-0004). */
  lazyLoadBody: boolean("lazy_load_body").notNull().default(true),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
