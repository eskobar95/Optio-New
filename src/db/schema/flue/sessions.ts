import { pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** Flue sidecar schema — session copy; Optio owns authoritative transcripts. */
export const flueSchema = pgSchema("flue");

export const sessions = flueSchema.table("sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  /** Soft link to optio.workspaces.id — no cross-schema FK. */
  optioWorkspaceId: uuid("optio_workspace_id"),
  /** Soft link to optio.transcripts.id (authoritative copy lives in Optio). */
  optioTranscriptId: uuid("optio_transcript_id"),
  /** Durable Flue conversation id for resume / usePersistentState. */
  durableConversationId: text("durable_conversation_id"),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
