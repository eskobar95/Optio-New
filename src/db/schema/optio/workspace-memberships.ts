import { primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { optioSchema } from "./tenants.js";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

/** User ↔ workspace membership (roles: owner | admin | member | viewer). */
export const workspaceMemberships = optioSchema.table(
  "workspace_memberships",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.workspaceId], name: "workspace_memberships_pkey" })],
);
