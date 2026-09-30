import { EVENT_TYPES, type EventType, eventSchema, schemaVersions } from "./events.js";

const base = {
  id: "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b",
  tenant_id: "11111111-1111-4111-8111-111111111111",
  workspace_id: "22222222-2222-4222-8222-222222222222",
  project_id: "33333333-3333-4333-8333-333333333333",
  work_item_id: "OPT-14",
  run_id: "run-0001",
  seq: 1,
  occurred_at: "2026-10-01T09:00:00.000Z",
  origin: "factory",
  device_id: null,
} as const;

const payloadFixtures: Record<EventType, unknown> = {
  "run.started": { runner: "claude-cli", model: "claude-sonnet-5-5", intent: "implement" },
  "run.ended": { outcome: "succeeded", duration_ms: 84210 },
  turn: { role: "assistant", index: 3, body: "Tests are green." },
  usage: {
    model: "claude-sonnet-5-5",
    input: 12840,
    output: 932,
    cached: 40210,
    cost_micros: 61250,
  },
  tool: { call_id: "call-7", name: "Bash", status: "succeeded", duration_ms: 1200 },
  status: { status: "implementing", detail: "red to green" },
  error: { code: "runner_timeout", message: "runner exceeded 600s", retryable: true },
  "gate.requested": {
    gate_id: "gate-1",
    kind: "continue_vs_escalate",
    subject: "npm run ci failed twice",
  },
  "gate.decided": {
    gate_id: "gate-1",
    decision: "escalated",
    decided_by: "jev",
    reason: "two failures",
  },
  signoff: { action: "git push", kind: "push", approved_by_jev: false, person: "Nicklas" },
  skill_pick: { skill: "tdd", candidates: ["tdd", "diagnosing-bugs"], picked_by: "jev" },
  failure: { class: "ci_red", message: "lint failed", recoverable: true },
  artifact: {
    kind: "diff",
    name: "opt-14.patch",
    media_type: "text/x-diff",
    blob: {
      sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      size: 48213,
    },
  },
  "membership.changed": {
    user_id: "44444444-4444-4444-8444-444444444444",
    role: "member",
    change: "added",
  },
  "project.created": { name: "Data Platform Foundation", slug: "data-platform-foundation" },
};

export type RegistryEntry = {
  version: number;
  schema: ReturnType<typeof eventSchema>;
  fixture: unknown;
};

/** Per type: current version, full event schema and one valid fixture event. */
export const eventRegistry = Object.fromEntries(
  EVENT_TYPES.map((type) => [
    type,
    {
      version: schemaVersions[type],
      schema: eventSchema(type),
      fixture: {
        ...base,
        type,
        schema_version: schemaVersions[type],
        payload: payloadFixtures[type],
      },
    },
  ]),
) as unknown as Record<EventType, RegistryEntry>;
