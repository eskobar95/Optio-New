import { pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const optioSchema = pgSchema("optio");

export const connectionKindEnum = optioSchema.enum("connection_kind", [
  "github",
  "linear",
  "slack",
  "mcp",
]);

export const codingBackendEnum = optioSchema.enum("coding_backend", [
  "cursor-cli",
  "flue",
  "codex",
]);

export const sandboxModeEnum = optioSchema.enum("sandbox_mode", ["local"]);

export const jevGateKindEnum = optioSchema.enum("jev_gate_kind", [
  "backend_cascade",
  "plan",
  "skill_pick",
  "review_prescreen",
  "intake",
]);

/** Vertical-stack stage kinds (ENG-28 / ENG-35) — not freeform canvas nodes. */
export const workflowStageTypeEnum = optioSchema.enum("workflow_stage_type", [
  "agent",
  "custom_agent",
  "gate",
  "aggregator",
  "branch",
  "integration",
]);

export const tenants = optioSchema.table("tenants", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
