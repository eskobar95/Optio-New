import { text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { codingBackendEnum, optioSchema, tenants } from "./tenants.js";

export const workspaces = optioSchema.table(
  "workspaces",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    /** Infisical environment slug — secret values stay out of the DB. */
    infisicalEnvSlug: text("infisical_env_slug"),
    /**
     * Default coding backend for the workspace.
     * Cursor CLI is reached via ENG-21 wrapper.
     */
    defaultCodingBackend: codingBackendEnum("default_coding_backend")
      .notNull()
      .default("cursor-cli"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("workspaces_tenant_id_slug_unique").on(t.tenantId, t.slug)],
);
