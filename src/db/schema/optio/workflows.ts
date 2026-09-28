import { boolean, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { optioSchema } from "./tenants.js";
import { workspaces } from "./workspaces.js";

export const workflows = optioSchema.table(
  "workflows",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    /** Path to workflow YAML SoT (e.g. `workflows/default-task.yaml`). */
    definitionRef: text("definition_ref").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("workflows_workspace_id_slug_unique").on(t.workspaceId, t.slug)],
);
