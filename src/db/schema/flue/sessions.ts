import { pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** Flue sidecar schema — stub for session copy (ENG-26 HTTP later). */
export const flueSchema = pgSchema("flue");

export const sessions = flueSchema.table("sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  /** Soft link to optio.workspaces.id — no cross-schema FK in the stub. */
  optioWorkspaceId: uuid("optio_workspace_id"),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
