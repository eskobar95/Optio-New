import { boolean, integer, jsonb, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { optioSchema } from "./tenants.js";
import { workspaces } from "./workspaces.js";

/** Optio-authoritative transcript header (Flue keeps a session copy). */
export const transcripts = optioSchema.table("transcripts", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  /** Soft link to flue.sessions.id — no cross-schema FK. */
  flueSessionId: uuid("flue_session_id"),
  taskId: text("task_id"),
  stage: text("stage"),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Append-only transcript turns. Compaction marks rows; never rewrite prior content.
 * Log compacted_tokens + cache_writes when a turn is compacted.
 */
export const transcriptEvents = optioSchema.table(
  "transcript_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    transcriptId: uuid("transcript_id")
      .notNull()
      .references(() => transcripts.id),
    seq: integer("seq").notNull(),
    role: text("role").notNull(),
    content: jsonb("content").$type<Record<string, unknown> | unknown[]>().notNull(),
    compacted: boolean("compacted").notNull().default(false),
    compactedTokens: integer("compacted_tokens"),
    cacheWrites: integer("cache_writes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("transcript_events_transcript_id_seq_unique").on(t.transcriptId, t.seq)],
);

/** Jev skill-pick feedback log (task type, selected skills, outcome). */
export const skillPickLogs = optioSchema.table("skill_pick_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  taskId: text("task_id"),
  taskType: text("task_type"),
  agentId: uuid("agent_id"),
  selectedSkillIds: jsonb("selected_skill_ids").$type<string[]>().notNull().default([]),
  outcome: text("outcome"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
