import { boolean, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { optioSchema } from "./tenants.js";
import { workspaces } from "./workspaces.js";

export const skills = optioSchema.table(
  "skills",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    /**
     * Path to SKILL.md SoT (folder + YAML frontmatter + Markdown body),
     * e.g. `.cursor/skills/<id>/SKILL.md`.
     */
    bodyRef: text("body_ref").notNull(),
    /** Optional skill folder path (parent of SKILL.md). */
    folderRef: text("folder_ref"),
    /** Optional YAML config SoT alongside SKILL.md. */
    configRef: text("config_ref"),
    description: text("description"),
    /** When true, catalog (name+description) first; full SKILL.md on select. */
    lazyLoadBody: boolean("lazy_load_body").notNull().default(true),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("skills_workspace_id_slug_unique").on(t.workspaceId, t.slug)],
);
