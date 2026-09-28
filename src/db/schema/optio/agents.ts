import { boolean, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { optioSchema } from "./tenants.js";
import { workspaces } from "./workspaces.js";

export const agents = optioSchema.table("agents", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  name: text("name").notNull(),
  /** Agent role/kind (planner, implementation, specialist, …). */
  kind: text("kind").notNull(),
  /** Path or id pointing at instructions SoT — not inline body. */
  instructionsRef: text("instructions_ref").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
