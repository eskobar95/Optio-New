import { text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { optioSchema, tenants } from "./tenants.js";

/** Auth v0 — email/password. Password hash only; no provider API tokens here. */
export const users = optioSchema.table(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("users_tenant_id_email_unique").on(t.tenantId, t.email)],
);
