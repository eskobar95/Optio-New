import { z } from "zod/v4";

/** Inline bodies above this many characters move to the BlobStore (spec decision: 16 KiB, a setting). */
export const INLINE_BODY_MAX_CHARS = 16 * 1024;

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const uuidv7Schema = z.string().regex(UUIDV7, "expected a UUIDv7");

export const blobRefSchema = z.strictObject({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().nonnegative(),
});
export type BlobRef = z.infer<typeof blobRefSchema>;

/** Exactly one of an inline `body` (under the size limit) or a `blob` ref. */
function withBody<T extends z.ZodRawShape>(shape: T) {
  return z.union([
    z.strictObject({ ...shape, body: z.string().max(INLINE_BODY_MAX_CHARS) }),
    z.strictObject({ ...shape, blob: blobRefSchema }),
  ]);
}

const int = () => z.number().int().nonnegative();

export const payloadSchemas = {
  "run.started": z.object({
    runner: z.string().min(1),
    model: z.string().nullable(),
    intent: z.string().nullable(),
  }),
  "run.ended": z.object({
    outcome: z.enum(["succeeded", "failed", "canceled"]),
    duration_ms: int(),
  }),
  turn: withBody({
    role: z.enum(["user", "assistant"]),
    index: int(),
  }),
  usage: z.object({
    model: z.string().min(1),
    input: int(),
    output: int(),
    cached: int(),
    cost_micros: int(),
  }),
  tool: z.object({
    call_id: z.string().min(1),
    name: z.string().min(1),
    status: z.enum(["started", "succeeded", "failed"]),
    duration_ms: int().optional(),
  }),
  status: z.object({
    status: z.string().min(1),
    detail: z.string().optional(),
  }),
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    retryable: z.boolean(),
  }),
  "gate.requested": z.object({
    gate_id: z.string().min(1),
    kind: z.string().min(1),
    subject: z.string(),
  }),
  "gate.decided": z.object({
    gate_id: z.string().min(1),
    decision: z.enum(["approved", "denied", "escalated"]),
    decided_by: z.enum(["jev", "person", "code"]),
    reason: z.string().optional(),
  }),
  signoff: z.object({
    action: z.string().min(1),
    kind: z.string().min(1),
    approved_by_jev: z.boolean(),
    reason: z.string().optional(),
    person: z.string().nullable(),
  }),
  skill_pick: z.object({
    skill: z.string().min(1),
    candidates: z.array(z.string()),
    picked_by: z.enum(["jev", "person", "rule"]),
  }),
  failure: z.object({
    class: z.string().min(1),
    message: z.string(),
    recoverable: z.boolean(),
  }),
  artifact: withBody({
    kind: z.string().min(1),
    name: z.string().min(1),
    media_type: z.string().optional(),
  }),
  "membership.changed": z.object({
    user_id: z.uuid(),
    role: z.string().min(1),
    change: z.enum(["added", "removed", "role_changed"]),
  }),
  "project.created": z.object({
    name: z.string().min(1),
    slug: z.string().min(1),
  }),
} as const;

export type EventType = keyof typeof payloadSchemas;
export const EVENT_TYPES = Object.keys(payloadSchemas) as EventType[];

export const ORIGINS = ["ide", "factory", "run"] as const;

const envelopeShape = {
  id: uuidv7Schema,
  tenant_id: z.uuid(),
  workspace_id: z.uuid(),
  project_id: z.uuid().nullable(),
  work_item_id: z.string().min(1).nullable(),
  run_id: z.string().min(1).nullable(),
  seq: int(),
  occurred_at: z.iso.datetime(),
  origin: z.enum(ORIGINS),
  device_id: z.string().min(1).nullable(),
};

/** The envelope shape without `type`, `schema_version` and `payload`. */
export const envelopeBaseSchema = z.object(envelopeShape);

/** Current schema version per type. Bump when a payload changes incompatibly. */
export const schemaVersions: Record<EventType, number> = {
  "run.started": 1,
  "run.ended": 1,
  turn: 1,
  usage: 1,
  tool: 1,
  status: 1,
  error: 1,
  "gate.requested": 1,
  "gate.decided": 1,
  signoff: 1,
  skill_pick: 1,
  failure: 1,
  artifact: 1,
  "membership.changed": 1,
  "project.created": 1,
};

/** Versions a parser accepts per type. Old versions stay here while readers still need them. */
export const supportedVersions: Record<EventType, readonly number[]> = Object.fromEntries(
  EVENT_TYPES.map((t) => [t, [schemaVersions[t]]]),
) as unknown as Record<EventType, readonly number[]>;

/** The full event schema (envelope + payload) for one type at its current version. */
export function eventSchema<T extends EventType>(type: T) {
  return z.object({
    ...envelopeShape,
    type: z.literal(type),
    schema_version: z.literal(schemaVersions[type]),
    payload: payloadSchemas[type],
  });
}

export type EventOf<T extends EventType> = z.infer<ReturnType<typeof eventSchema<T>>>;
export type PlatformEvent = { [T in EventType]: EventOf<T> }[EventType];
