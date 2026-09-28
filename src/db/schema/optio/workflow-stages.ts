import { boolean, integer, jsonb, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { connections } from "./connections.js";
import { jevGateKindEnum, optioSchema, workflowStageTypeEnum } from "./tenants.js";
import { workflows } from "./workflows.js";

/**
 * Ordered stage inside a workflow vertical stack (ADR-0001 / ENG-35).
 * `sort_order` is the stack position; `stage_type` + `config` drive the row.
 */
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
    stageType: workflowStageTypeEnum("stage_type").notNull().default("agent"),
    /** Stage-specific knobs (gate rules, custom-agent toggles, integration action). */
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    /** Optional primary agent for agent / custom_agent stages. */
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    /** Optional integration ref for integration stages (GitHub/Linear/Slack). */
    connectionId: uuid("connection_id").references(() => connections.id, {
      onDelete: "set null",
    }),
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
