import { pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const optioSchema = pgSchema("optio");

export const tenants = optioSchema.table("tenants", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
