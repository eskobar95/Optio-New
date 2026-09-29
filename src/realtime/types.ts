/**
 * Typed realtime event contract (ENG-40).
 * Shared by cloud WSS and local Tauri IPC — never carry a full transcript tick.
 */
import { z } from "zod";

export const CHANNEL_KINDS = ["session", "workspace", "system"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export const SYSTEM_CHANNEL_NAMES = ["status"] as const;
export type SystemChannelName = (typeof SYSTEM_CHANNEL_NAMES)[number];

/** Multiplex channel id, e.g. `session:abc`, `workspace:ws-1`, `system:status`. */
export type ChannelId = `session:${string}` | `workspace:${string}` | `system:${SystemChannelName}`;

export const RUN_STATUSES = [
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RunTokenPayloadSchema = z.object({
  runId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128),
  text: z.string().max(4096),
  /** Optional stream role; omitted = assistant. */
  role: z.enum(["assistant", "system"]).optional(),
});
export type RunTokenPayload = z.infer<typeof RunTokenPayloadSchema>;

export const RunToolPayloadSchema = z.object({
  runId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128),
  toolCallId: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  phase: z.enum(["start", "progress", "end"]),
  /** Small summary only — never full tool I/O blobs. */
  summary: z.string().max(1024).optional(),
});
export type RunToolPayload = z.infer<typeof RunToolPayloadSchema>;

export const RunStatusPayloadSchema = z.object({
  runId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128),
  status: z.enum(RUN_STATUSES),
  /** Optional human-readable reason; not a transcript. */
  reason: z.string().max(512).optional(),
});
export type RunStatusPayload = z.infer<typeof RunStatusPayloadSchema>;

export const RunErrorPayloadSchema = z.object({
  runId: z.string().min(1).max(128).optional(),
  sessionId: z.string().min(1).max(128).optional(),
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(512),
});
export type RunErrorPayload = z.infer<typeof RunErrorPayloadSchema>;

export const HeartbeatPayloadSchema = z.object({
  ts: z.number().int().nonnegative(),
});
export type HeartbeatPayload = z.infer<typeof HeartbeatPayloadSchema>;

export const ActiveRunSnapshotSchema = z.object({
  runId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128),
  status: z.enum(RUN_STATUSES),
  updatedAt: z.number().int().nonnegative(),
});
export type ActiveRunSnapshot = z.infer<typeof ActiveRunSnapshotSchema>;

export const SnapshotPayloadSchema = z.object({
  lastSeq: z.number().int().nonnegative(),
  activeRuns: z.array(ActiveRunSnapshotSchema).max(500),
  channels: z.array(z.string().min(1).max(200)).max(100),
});
export type SnapshotPayload = z.infer<typeof SnapshotPayloadSchema>;

/** Server → client push events (all carry seq except heartbeat may omit in some paths — we always assign seq). */
export type LiveEventType =
  "run.token" | "run.tool" | "run.status" | "run.error" | "heartbeat" | "snapshot";

export type LiveEvent =
  | { type: "run.token"; seq: number; channel: ChannelId; ts: number; payload: RunTokenPayload }
  | { type: "run.tool"; seq: number; channel: ChannelId; ts: number; payload: RunToolPayload }
  | { type: "run.status"; seq: number; channel: ChannelId; ts: number; payload: RunStatusPayload }
  | { type: "run.error"; seq: number; channel: ChannelId; ts: number; payload: RunErrorPayload }
  | { type: "heartbeat"; seq: number; channel: ChannelId; ts: number; payload: HeartbeatPayload }
  | { type: "snapshot"; seq: number; channel: ChannelId; ts: number; payload: SnapshotPayload };

/** Control frames (client ↔ server). */
export type ClientControlType =
  "subscribe" | "unsubscribe" | "catchup" | "ping" | "auth" | "cancel_run" | "tab_focus";

export type ServerControlType = "subscribe.ack" | "unsubscribe.ack" | "error" | "pong" | "auth.ack";

export const SubscribeFrameSchema = z.object({
  type: z.literal("subscribe"),
  channels: z.array(z.string().min(1).max(200)).min(1).max(50),
  /** Resume cursor; server replies with snapshot then deltas with seq > lastSeq. */
  lastSeq: z.number().int().nonnegative().optional(),
});

export const UnsubscribeFrameSchema = z.object({
  type: z.literal("unsubscribe"),
  channels: z.array(z.string().min(1).max(200)).min(1).max(50),
});

export const CatchupFrameSchema = z.object({
  type: z.literal("catchup"),
  lastSeq: z.number().int().nonnegative(),
  channels: z.array(z.string().min(1).max(200)).max(50).optional(),
});

export const PingFrameSchema = z.object({
  type: z.literal("ping"),
  ts: z.number().int().nonnegative().optional(),
});

export const AuthFrameSchema = z.object({
  type: z.literal("auth"),
  token: z.string().min(1).max(4096),
});

export const CancelRunFrameSchema = z.object({
  type: z.literal("cancel_run"),
  runId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128),
});

export const TabFocusSchema = z.object({
  type: z.literal("tab_focus"),
  focused: z.boolean(),
  /** When unfocused, client may request status-only downgrade. */
  statusOnly: z.boolean().optional(),
});

export const ClientFrameSchema = z.discriminatedUnion("type", [
  SubscribeFrameSchema,
  UnsubscribeFrameSchema,
  CatchupFrameSchema,
  PingFrameSchema,
  AuthFrameSchema,
  CancelRunFrameSchema,
  TabFocusSchema,
]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

export const ServerErrorFrameSchema = z.object({
  type: z.literal("error"),
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(512),
  /** HTTP-like hint; 401 stops client reconnect. */
  status: z.number().int().optional(),
});
export type ServerErrorFrame = z.infer<typeof ServerErrorFrameSchema>;

export const SubscribeAckSchema = z.object({
  type: z.literal("subscribe.ack"),
  channels: z.array(z.string().min(1).max(200)),
  lastSeq: z.number().int().nonnegative(),
});

export const UnsubscribeAckSchema = z.object({
  type: z.literal("unsubscribe.ack"),
  channels: z.array(z.string().min(1).max(200)),
});

export const PongSchema = z.object({
  type: z.literal("pong"),
  ts: z.number().int().nonnegative(),
});

export const AuthAckSchema = z.object({
  type: z.literal("auth.ack"),
  expiresAt: z.number().int().nonnegative().optional(),
});

export type ServerControlFrame =
  | z.infer<typeof SubscribeAckSchema>
  | z.infer<typeof UnsubscribeAckSchema>
  | ServerErrorFrame
  | z.infer<typeof PongSchema>
  | z.infer<typeof AuthAckSchema>;

/** Any outbound wire message (control or live event). */
export type OutboundFrame = ServerControlFrame | LiveEvent;

/** Events that must never be dropped under backpressure. */
export const CRITICAL_EVENT_TYPES = new Set<LiveEventType | ServerControlType>([
  "run.status",
  "run.error",
  "error",
  "snapshot",
  "subscribe.ack",
  "unsubscribe.ack",
  "auth.ack",
]);

export function isCriticalOutbound(frame: OutboundFrame): boolean {
  return CRITICAL_EVENT_TYPES.has(frame.type as LiveEventType | ServerControlType);
}

export function isTokenEvent(
  frame: OutboundFrame,
): frame is Extract<LiveEvent, { type: "run.token" }> {
  return frame.type === "run.token";
}

/** Strict channel id schema shared by the wire contract (server + client). */
export const ChannelIdSchema = z
  .string()
  .regex(/^session:[A-Za-z0-9_.:-]{1,128}$/)
  .or(z.string().regex(/^workspace:[A-Za-z0-9_.:-]{1,128}$/))
  .or(z.literal("system:status"));

const seqField = z.number().int().nonnegative();
const tsField = z.number().int().nonnegative();

/** One schema per live event type — the client-decodes and server-encodes the same shape. */
export const RunTokenEventSchema = z.object({
  type: z.literal("run.token"),
  seq: seqField,
  channel: ChannelIdSchema,
  ts: tsField,
  payload: RunTokenPayloadSchema,
});

export const RunToolEventSchema = z.object({
  type: z.literal("run.tool"),
  seq: seqField,
  channel: ChannelIdSchema,
  ts: tsField,
  payload: RunToolPayloadSchema,
});

export const RunStatusEventSchema = z.object({
  type: z.literal("run.status"),
  seq: seqField,
  channel: ChannelIdSchema,
  ts: tsField,
  payload: RunStatusPayloadSchema,
});

export const RunErrorEventSchema = z.object({
  type: z.literal("run.error"),
  seq: seqField,
  channel: ChannelIdSchema,
  ts: tsField,
  payload: RunErrorPayloadSchema,
});

export const HeartbeatEventSchema = z.object({
  type: z.literal("heartbeat"),
  seq: seqField,
  channel: ChannelIdSchema,
  ts: tsField,
  payload: HeartbeatPayloadSchema,
});

export const SnapshotEventSchema = z.object({
  type: z.literal("snapshot"),
  seq: seqField,
  channel: ChannelIdSchema,
  ts: tsField,
  payload: SnapshotPayloadSchema,
});

export const LiveEventSchema = z.discriminatedUnion("type", [
  RunTokenEventSchema,
  RunToolEventSchema,
  RunStatusEventSchema,
  RunErrorEventSchema,
  HeartbeatEventSchema,
  SnapshotEventSchema,
]);

/** Full server → client wire contract: live events plus control responses. */
export const OutboundFrameSchema = z.discriminatedUnion("type", [
  RunTokenEventSchema,
  RunToolEventSchema,
  RunStatusEventSchema,
  RunErrorEventSchema,
  HeartbeatEventSchema,
  SnapshotEventSchema,
  SubscribeAckSchema,
  UnsubscribeAckSchema,
  ServerErrorFrameSchema,
  PongSchema,
  AuthAckSchema,
]);
