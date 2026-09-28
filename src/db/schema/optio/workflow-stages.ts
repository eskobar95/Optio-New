import { boolean, integer, jsonb, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { jevGateKindEnum, optioSchema } from "./tenants.js";
import { workflows } from "./workflows.js";

/** Configurable stage inside a workflow (plan, implement, review, …). */
export const workflowStages = optioSchema.table(
  "workflow_stages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    /** Optional primary agent for this stage. */
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("workflow_stages_workflow_id_slug_unique").on(t.workflowId, t.slug)],
);

/**
 * Jev gate config attached per stage.
 * Soft gates use timeout → passthrough (`passthrough_on_timeout`).
 */
export const stageJevGates = optioSchema.table(
  "stage_jev_gates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workflowStageId: uuid("workflow_stage_id")
      .notNull()
      .references(() => workflowStages.id, { onDelete: "cascade" }),
    gateKind: jevGateKindEnum("gate_kind").notNull(),
    /** Thresholds and routing knobs — stored; no day-one manual tuning required. */
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    timeoutMs: integer("timeout_ms").notNull().default(30_000),
    passthroughOnTimeout: boolean("passthrough_on_timeout").notNull().default(true),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("stage_jev_gates_workflow_stage_id_gate_kind_unique").on(t.workflowStageId, t.gateKind),
  ],
);
