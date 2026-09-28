import { boolean, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { optioSchema } from "./tenants.js";
import { workspaces } from "./workspaces.js";

export const skills = optioSchema.table(
  "skills",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    /** Path to skill SoT (e.g. `.cursor/skills/<id>/SKILL.md`). */
    bodyRef: text("body_ref").notNull(),
    description: text("description"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("skills_workspace_id_slug_unique").on(t.workspaceId, t.slug)],
);
