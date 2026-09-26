/**
 * Human-in-the-loop gates for plan (before implement) and merge (before merge_branch).
 * Ready runs open_pr and record_ci_wait without the merge gate, so a Linear task
 * can move to Review when CI is green. A required gate never approves itself:
 * timeout notifies and stays closed.
 * High planner confidence may record a policy approval only when the mode allows it.
 * See docs/hitl.md.
 */
import { UnrecoverableError } from "bullmq";
import { parse } from "yaml";
import { z } from "zod";
import type { StepCursorStore } from "./cursor.js";
import { type PipelineStage } from "./stages.js";

export const HITL_POINTS = ["plan", "merge"] as const;
export type HitlPoint = (typeof HITL_POINTS)[number];

export const HITL_MODES = ["off", "when_confidence_low", "always"] as const;
export type HitlMode = (typeof HITL_MODES)[number];

export const HITL_ACTIONS = ["approve", "reject", "replan"] as const;
export type HitlAction = (typeof HITL_ACTIONS)[number];

export const HITL_STATUSES = ["pending", "approved", "rejected", "replan", "timed_out"] as const;
export type HitlStatus = (typeof HITL_STATUSES)[number];

export const HITL_SOURCES = ["policy", "human", "timeout", "gate"] as const;
export type HitlSource = (typeof HITL_SOURCES)[number];

export const DEFAULT_HITL_CONFIDENCE_THRESHOLD = 0.8;
export const DEFAULT_HITL_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_HITL_POLL_MS = 60_000;

export interface HitlPointConfig {
  mode: HitlMode;
  confidenceThreshold: number;
}

export interface HitlConfig {
  plan: HitlPointConfig;
  merge: HitlPointConfig;
  timeoutMs: number;
  pollMs: number;
}

export interface HitlRecord {
  taskId: string;
  sessionId: string;
  point: HitlPoint;
  status: HitlStatus;
  confidence?: number;
  reason: string;
  source: HitlSource;
  requestedAt: string;
  decidedAt?: string;
  notifiedAt?: string;
  timeoutAt: string;
}

export interface HitlStore {
  get(taskId: string, sessionId: string, point: HitlPoint): Promise<HitlRecord | undefined>;
  save(record: HitlRecord): Promise<void>;
  delete(taskId: string, sessionId: string, point: HitlPoint): Promise<void>;
  list(taskId: string, sessionId: string): Promise<HitlRecord[]>;
}

export interface HitlSignalStore {
  note(signal: {
    taskId: string;
    sessionId: string;
    point: HitlPoint;
    confidence: number;
  }): Promise<void>;
  read(taskId: string, sessionId: string, point: HitlPoint): Promise<number | undefined>;
}

export type HitlNotifyKind = "pause" | "timeout" | "approved" | "rejected" | "replan";

export interface HitlNotifyEvent {
  taskId: string;
  sessionId: string;
  point: HitlPoint;
  kind: HitlNotifyKind;
  reason: string;
  status: HitlStatus;
  timeoutAt?: string;
}

export type HitlResumeStage = "plan" | "implement" | "merge";

export interface HitlQueuePort {
  /** Promote or re-add the stage job so BullMQ runs it again. */
  resumePaused(
    stage: HitlResumeStage,
    identity: { taskId: string; sessionId: string },
  ): Promise<void>;
  requeuePlan(identity: { taskId: string; sessionId: string }): Promise<void>;
}

export interface HitlBinding {
  config: HitlConfig;
  store: HitlStore;
  signals: HitlSignalStore;
  now?: () => Date;
  notify?: (event: HitlNotifyEvent) => Promise<void> | void;
  queue?: HitlQueuePort;
}

export interface HitlJobHandle {
  getState(): Promise<string>;
  promote(): Promise<void>;
  remove(): Promise<void>;
  readonly data?: unknown;
}

export interface HitlJobQueue {
  getJob(jobId: string): Promise<HitlJobHandle | undefined>;
  add(
    name: string,
    data: { taskId: string; sessionId: string; stage: PipelineStage },
    opts: { jobId: string },
  ): Promise<unknown>;
}

const PointSchema = z
  .object({
    mode: z.enum(HITL_MODES),
    confidence_threshold: z.number().finite().min(0).max(1).optional(),
  })
  .strict();

const HitlYamlSchema = z
  .object({
    plan: PointSchema.optional(),
    merge: PointSchema.optional(),
    timeout_ms: z.number().int().nonnegative().optional(),
    poll_ms: z.number().int().nonnegative().optional(),
  })
  .strict();

export function pointForStage(stage: PipelineStage): HitlPoint | undefined {
  if (stage === "implement") return "plan";
  if (stage === "merge") return "merge";
  return undefined;
}

export function resumeStageForPoint(point: HitlPoint): "implement" | "merge" {
  return point === "plan" ? "implement" : "merge";
}

function readOptionalNumber(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${key} must be a finite number`);
  return value;
}

function readMode(raw: string | undefined, key: string): HitlMode | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const mode = raw.trim();
  if ((HITL_MODES as readonly string[]).includes(mode)) return mode as HitlMode;
  throw new Error(`${key} must be off, when_confidence_low, or always`);
}

function readYamlDocument(workflowYaml: string): Record<string, unknown> {
  const parsed: unknown = parse(workflowYaml);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("workflow YAML must be a map");
  }
  return parsed as Record<string, unknown>;
}

/** Env overrides YAML. Defaults: plan pauses when confidence is low; merge always pauses. */
export function loadHitlConfig(env: NodeJS.ProcessEnv, workflowYaml?: string): HitlConfig {
  let yamlPlan: z.infer<typeof PointSchema> | undefined;
  let yamlMerge: z.infer<typeof PointSchema> | undefined;
  let yamlTimeout: number | undefined;
  let yamlPoll: number | undefined;
  if (workflowYaml) {
    const doc = readYamlDocument(workflowYaml);
    if (doc.hitl !== undefined) {
      const parsed = HitlYamlSchema.safeParse(doc.hitl);
      if (!parsed.success) throw new Error("hitl config is invalid");
      yamlPlan = parsed.data.plan;
      yamlMerge = parsed.data.merge;
      yamlTimeout = parsed.data.timeout_ms;
      yamlPoll = parsed.data.poll_ms;
    }
  }
  const envThreshold = readOptionalNumber(env, "OPTIO_HITL_CONFIDENCE_THRESHOLD");
  if (envThreshold !== undefined && (envThreshold < 0 || envThreshold > 1)) {
    throw new Error("OPTIO_HITL_CONFIDENCE_THRESHOLD must be between 0 and 1");
  }
  const threshold = envThreshold ?? DEFAULT_HITL_CONFIDENCE_THRESHOLD;
  const timeoutMs =
    readOptionalNumber(env, "OPTIO_HITL_TIMEOUT_MS") ?? yamlTimeout ?? DEFAULT_HITL_TIMEOUT_MS;
  const pollMs = readOptionalNumber(env, "OPTIO_HITL_POLL_MS") ?? yamlPoll ?? DEFAULT_HITL_POLL_MS;
  if (timeoutMs < 0 || pollMs < 0) throw new Error("hitl timeout and poll must be >= 0");
  const planMode =
    readMode(env.OPTIO_HITL_PLAN, "OPTIO_HITL_PLAN") ?? yamlPlan?.mode ?? "when_confidence_low";
  const mergeMode =
    readMode(env.OPTIO_HITL_MERGE, "OPTIO_HITL_MERGE") ?? yamlMerge?.mode ?? "always";
  return {
    plan: {
      mode: planMode,
      confidenceThreshold: envThreshold ?? yamlPlan?.confidence_threshold ?? threshold,
    },
    merge: {
      mode: mergeMode,
      confidenceThreshold: envThreshold ?? yamlMerge?.confidence_threshold ?? threshold,
    },
    timeoutMs,
    pollMs,
  };
}

function confidenceAllowsAuto(confidence: number | undefined, threshold: number): boolean {
  return (
    typeof confidence === "number" &&
    Number.isFinite(confidence) &&
    confidence >= 0 &&
    confidence <= 1 &&
    confidence >= threshold
  );
}

export function humanRequired(config: HitlPointConfig, confidence: number | undefined): boolean {
  if (config.mode === "off") return false;
  if (config.mode === "always") return true;
  return !confidenceAllowsAuto(confidence, config.confidenceThreshold);
}

export function logHitlEvent(event: HitlNotifyEvent): void {
  console.log(
    JSON.stringify({
      msg: "hitl",
      taskId: event.taskId,
      sessionId: event.sessionId,
      point: event.point,
      kind: event.kind,
      status: event.status,
      reason: event.reason,
      ...(event.timeoutAt ? { timeoutAt: event.timeoutAt } : {}),
    }),
  );
}

async function notify(binding: HitlBinding, event: HitlNotifyEvent): Promise<void> {
  if (binding.notify) await binding.notify(event);
  else logHitlEvent(event);
}

function clock(binding: HitlBinding): Date {
  return (binding.now ?? (() => new Date()))();
}

export class ApprovalRequiredError extends Error {
  readonly code = "approval_required" as const;
  readonly record: HitlRecord;

  constructor(record: HitlRecord) {
    super(
      `approval required at ${record.point} for task ${record.taskId} (${record.status}: ${record.reason})`,
    );
    this.name = "ApprovalRequiredError";
    this.record = record;
  }
}

export class ApprovalRejectedError extends UnrecoverableError {
  readonly code = "approval_rejected" as const;
  readonly record: HitlRecord;

  constructor(record: HitlRecord) {
    super(`approval rejected at ${record.point} for task ${record.taskId}`);
    this.name = "ApprovalRejectedError";
    this.record = record;
  }
}

export class ApprovalReplanError extends UnrecoverableError {
  readonly code = "approval_replan" as const;
  readonly record: HitlRecord;

  constructor(record: HitlRecord) {
    super(`approval replan at ${record.point} for task ${record.taskId}`);
    this.name = "ApprovalReplanError";
    this.record = record;
  }
}

export class HitlDecisionError extends Error {
  readonly statusCode = 409 as const;
  readonly code = "not_awaiting" as const;

  constructor(message: string) {
    super(message);
    this.name = "HitlDecisionError";
  }
}

export type HitlGateResult =
  | { kind: "skip" }
  | { kind: "continue"; record?: HitlRecord }
  | { kind: "pause"; record: HitlRecord }
  | { kind: "reject"; record: HitlRecord }
  | { kind: "replan"; record: HitlRecord };

function throwGate(result: Exclude<HitlGateResult, { kind: "skip" | "continue" }>): never {
  if (result.kind === "pause") throw new ApprovalRequiredError(result.record);
  if (result.kind === "reject") throw new ApprovalRejectedError(result.record);
  throw new ApprovalReplanError(result.record);
}

/** Existing reject/replan stops the stage even when the previous cursor was reset. */
export async function existingHitlBlock(
  stage: PipelineStage,
  binding: HitlBinding,
  identity: { taskId: string; sessionId: string },
): Promise<Extract<HitlGateResult, { kind: "reject" | "replan" }> | undefined> {
  const point = pointForStage(stage);
  if (!point || binding.config[point].mode === "off") return undefined;
  const record = await binding.store.get(identity.taskId, identity.sessionId, point);
  if (record?.status === "rejected") return { kind: "reject", record };
  if (record?.status === "replan") return { kind: "replan", record };
  return undefined;
}

export async function assertNoTerminalHitl(
  stage: PipelineStage,
  binding: HitlBinding,
  identity: { taskId: string; sessionId: string },
): Promise<void> {
  const blocked = await existingHitlBlock(stage, binding, identity);
  if (blocked) throwGate(blocked);
}

/**
 * Open or refresh the gate for this stage. Does not auto-approve when a human is required.
 * Timeout moves pending → timed_out, notifies once, and still pauses.
 */
export async function evaluateHitlGate(
  stage: PipelineStage,
  binding: HitlBinding,
  identity: { taskId: string; sessionId: string },
): Promise<HitlGateResult> {
  const point = pointForStage(stage);
  if (!point) return { kind: "skip" };
  const config = binding.config[point];
  if (config.mode === "off") return { kind: "skip" };

  const existing = await binding.store.get(identity.taskId, identity.sessionId, point);
  if (existing?.status === "approved") return { kind: "continue", record: existing };
  if (existing?.status === "rejected") return { kind: "reject", record: existing };
  if (existing?.status === "replan") return { kind: "replan", record: existing };

  const now = clock(binding);
  if (existing && (existing.status === "pending" || existing.status === "timed_out")) {
    const due = Date.parse(existing.timeoutAt);
    if (existing.status === "pending" && Number.isFinite(due) && now.getTime() >= due) {
      const timed: HitlRecord = {
        ...existing,
        status: "timed_out",
        source: "timeout",
        reason: "timeout_no_auto_approve",
        decidedAt: now.toISOString(),
        notifiedAt: now.toISOString(),
      };
      await binding.store.save(timed);
      await notify(binding, {
        taskId: identity.taskId,
        sessionId: identity.sessionId,
        point,
        kind: "timeout",
        reason: timed.reason,
        status: "timed_out",
        timeoutAt: timed.timeoutAt,
      });
      return { kind: "pause", record: timed };
    }
    return { kind: "pause", record: existing };
  }

  const confidence = await binding.signals.read(identity.taskId, identity.sessionId, point);
  if (!humanRequired(config, confidence)) {
    const decidedAt = now.toISOString();
    const record: HitlRecord = {
      taskId: identity.taskId,
      sessionId: identity.sessionId,
      point,
      status: "approved",
      ...(confidenceAllowsAuto(confidence, config.confidenceThreshold) ? { confidence } : {}),
      reason: "confidence_at_or_above_threshold",
      source: "policy",
      requestedAt: decidedAt,
      decidedAt,
      notifiedAt: decidedAt,
      timeoutAt: new Date(now.getTime() + binding.config.timeoutMs).toISOString(),
    };
    await binding.store.save(record);
    await notify(binding, {
      taskId: identity.taskId,
      sessionId: identity.sessionId,
      point,
      kind: "approved",
      reason: record.reason,
      status: "approved",
    });
    return { kind: "continue", record };
  }

  const requestedAt = now.toISOString();
  const record: HitlRecord = {
    taskId: identity.taskId,
    sessionId: identity.sessionId,
    point,
    status: "pending",
    ...(typeof confidence === "number" && confidenceAllowsAuto(confidence, 0)
      ? { confidence }
      : {}),
    reason: "awaiting_human",
    source: "gate",
    requestedAt,
    notifiedAt: requestedAt,
    timeoutAt: new Date(now.getTime() + binding.config.timeoutMs).toISOString(),
  };
  await binding.store.save(record);
  await notify(binding, {
    taskId: identity.taskId,
    sessionId: identity.sessionId,
    point,
    kind: "pause",
    reason: record.reason,
    status: "pending",
    timeoutAt: record.timeoutAt,
  });
  return { kind: "pause", record };
}

export async function enforceHitlGate(
  stage: PipelineStage,
  binding: HitlBinding,
  identity: { taskId: string; sessionId: string },
): Promise<void> {
  const result = await evaluateHitlGate(stage, binding, identity);
  if (result.kind === "skip" || result.kind === "continue") return;
  throwGate(result);
}

/** After a replanned planner run, drop the replan row and wake the paused stage. */
export async function releaseReplanAfterPlan(
  binding: HitlBinding,
  identity: { taskId: string; sessionId: string },
): Promise<void> {
  for (const point of HITL_POINTS) {
    const record = await binding.store.get(identity.taskId, identity.sessionId, point);
    if (record?.status !== "replan") continue;
    await binding.store.delete(identity.taskId, identity.sessionId, point);
    await binding.queue?.resumePaused(resumeStageForPoint(point), identity);
  }
}

export async function applyHitlDecision(
  input: { taskId: string; sessionId: string; point: HitlPoint; action: HitlAction },
  binding: HitlBinding,
  cursors: StepCursorStore,
): Promise<HitlRecord> {
  const existing = await binding.store.get(input.taskId, input.sessionId, input.point);
  if (!existing) {
    throw new HitlDecisionError(`no approval is waiting at ${input.point}`);
  }
  const stage = resumeStageForPoint(input.point);
  if (existing.status === "approved" && input.action === "approve") {
    await binding.queue?.resumePaused(stage, input);
    return existing;
  }
  if (existing.status === "rejected" && input.action === "reject") return existing;
  if (existing.status === "replan" && input.action === "replan") return existing;
  if (existing.status !== "pending" && existing.status !== "timed_out") {
    throw new HitlDecisionError(`approval at ${input.point} is already ${existing.status}`);
  }

  const now = clock(binding).toISOString();
  if (input.action === "approve") {
    const record: HitlRecord = {
      ...existing,
      status: "approved",
      source: "human",
      reason: "human_approve",
      decidedAt: now,
      notifiedAt: now,
    };
    await binding.store.save(record);
    await notify(binding, {
      taskId: input.taskId,
      sessionId: input.sessionId,
      point: input.point,
      kind: "approved",
      reason: record.reason,
      status: "approved",
    });
    await binding.queue?.resumePaused(stage, input);
    return record;
  }

  if (input.action === "reject") {
    const record: HitlRecord = {
      ...existing,
      status: "rejected",
      source: "human",
      reason: "human_reject",
      decidedAt: now,
      notifiedAt: now,
    };
    await binding.store.save(record);
    await notify(binding, {
      taskId: input.taskId,
      sessionId: input.sessionId,
      point: input.point,
      kind: "rejected",
      reason: record.reason,
      status: "rejected",
    });
    await binding.queue?.resumePaused(stage, input);
    return record;
  }

  const record: HitlRecord = {
    ...existing,
    status: "replan",
    source: "human",
    reason: "human_replan",
    decidedAt: now,
    notifiedAt: now,
  };
  await binding.store.save(record);
  await cursors.save({
    taskId: input.taskId,
    sessionId: input.sessionId,
    stage: "plan",
    nextStepIndex: 0,
    status: "pending",
    updatedAt: now,
  });
  await notify(binding, {
    taskId: input.taskId,
    sessionId: input.sessionId,
    point: input.point,
    kind: "replan",
    reason: record.reason,
    status: "replan",
  });
  await binding.queue?.requeuePlan(input);
  await binding.queue?.resumePaused(stage, input);
  return record;
}

export function hitlJobId(sessionId: string, stage: HitlResumeStage): string {
  return `${sessionId}__${stage}`;
}

export function createHitlQueuePort(queues: {
  plan: HitlJobQueue;
  implement: HitlJobQueue;
  merge: HitlJobQueue;
}): HitlQueuePort {
  return {
    resumePaused: (stage, identity) => wake(queues[stage], stage, identity),
    requeuePlan: (identity) => wake(queues.plan, "plan", identity),
  };
}

async function wake(
  queue: HitlJobQueue,
  stage: HitlResumeStage,
  identity: { taskId: string; sessionId: string },
): Promise<void> {
  const jobId = hitlJobId(identity.sessionId, stage);
  const fallback = { taskId: identity.taskId, sessionId: identity.sessionId, stage };
  const job = await queue.getJob(jobId);
  if (!job) {
    await queue.add(stage, fallback, { jobId });
    return;
  }
  const state = await job.getState();
  if (state === "delayed") {
    await job.promote();
    return;
  }
  // waiting-children is the flow parent still blocked on an earlier stage.
  // Leave that job in place; it reads the approval when its child finishes.
  if (
    state === "waiting" ||
    state === "paused" ||
    state === "active" ||
    state === "waiting-children"
  ) {
    return;
  }
  const data =
    job.data && typeof job.data === "object"
      ? (job.data as { taskId: string; sessionId: string; stage: PipelineStage })
      : fallback;
  await job.remove();
  await queue.add(stage, data, { jobId });
}
