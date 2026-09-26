/**
 * Fold one failure into the learnings table.
 * Crossing the threshold stores a meta-issue draft and, when a publisher is enabled, files it.
 * This module has no writer for workflow YAML, skill files, or review gates.
 */
import { failureFingerprint, normalizeObservation } from "./observation.js";
import { createDisabledMetaIssuePublisher, type MetaIssuePublisher } from "./publisher.js";
import type { LearningOccurrence, LearningRecord, LearningStore } from "./store.js";
import { renderMetaIssue } from "./template.js";

export interface LearningConfig {
  threshold: number;
  windowDays: number;
}

export interface LearningProcessorDeps {
  store: LearningStore;
  publisher?: MetaIssuePublisher;
  threshold?: number;
  windowDays?: number;
  now?: () => Date;
}

export interface LearningJobResult {
  fingerprint: string;
  hitCount: number;
  status: "observed" | "proposed";
  proposalBody: string | null;
  metaIssueUrl: string | null;
  /** Always false. Production gates are not rewritten. */
  rewroteProductionGates: false;
}

const MAX_OCCURRENCES = 50;

export function readLearningConfig(env: NodeJS.ProcessEnv = process.env): LearningConfig {
  return {
    threshold: positiveInt(env.OPTIO_LEARN_THRESHOLD, 3),
    windowDays: positiveInt(env.OPTIO_LEARN_WINDOW_DAYS, 14),
  };
}

export async function processLearningObservation(
  input: unknown,
  deps: LearningProcessorDeps,
): Promise<LearningJobResult> {
  const now = deps.now?.() ?? new Date();
  const threshold = deps.threshold ?? 3;
  const windowDays = deps.windowDays ?? 14;
  const publisher = deps.publisher ?? createDisabledMetaIssuePublisher();
  const observation = normalizeObservation(input, now);
  const fingerprint = failureFingerprint(observation);
  const existing = await deps.store.get(fingerprint);
  const occurrences = mergeOccurrence(existing?.occurrences ?? [], {
    key: observation.occurrenceKey,
    taskId: observation.taskId,
    sessionId: observation.sessionId,
    source: observation.source,
    attempt: observation.attempt,
    occurredAt: observation.occurredAt,
    excerpt: observation.excerpt,
  });
  const hits = occurrences.filter((item) => inWindow(item.occurredAt, now, windowDays));
  const sampleTaskIds = uniqueTaskIds(hits).slice(-8);
  const crossed = hits.length >= threshold || existing?.status === "proposed";
  let proposalBody = existing?.proposalBody ?? null;
  let metaIssueUrl = existing?.metaIssueUrl ?? null;
  const status = crossed ? "proposed" : "observed";

  if (status === "proposed" && !proposalBody) {
    proposalBody = renderMetaIssue({
      fingerprint,
      workflowId: observation.workflowId,
      stepId: observation.stepId,
      skillIds: observation.skillIds,
      specialistIds: observation.specialistIds,
      errorClass: observation.errorClass,
      field: observation.field,
      hitCount: hits.length,
      threshold,
      windowDays,
      sampleTaskIds,
    }).body;
  }

  if (status === "proposed" && !metaIssueUrl && proposalBody) {
    const draft = renderMetaIssue({
      fingerprint,
      workflowId: observation.workflowId,
      stepId: observation.stepId,
      skillIds: observation.skillIds,
      specialistIds: observation.specialistIds,
      errorClass: observation.errorClass,
      field: observation.field,
      hitCount: hits.length,
      threshold,
      windowDays,
      sampleTaskIds,
    });
    const published = await publisher.publish(draft);
    if (published.url) metaIssueUrl = published.url;
  }

  const record: LearningRecord = {
    fingerprint,
    workflowId: observation.workflowId,
    stepId: observation.stepId,
    skillIds: observation.skillIds,
    specialistIds: observation.specialistIds,
    errorClass: observation.errorClass,
    field: observation.field,
    occurrences,
    hitCount: hits.length,
    status,
    excerpt: observation.excerpt,
    sampleTaskIds,
    proposalBody,
    metaIssueUrl,
    updatedAt: now.toISOString(),
  };
  await deps.store.save(record);

  return {
    fingerprint,
    hitCount: hits.length,
    status,
    proposalBody,
    metaIssueUrl,
    rewroteProductionGates: false,
  };
}

function mergeOccurrence(
  existing: readonly LearningOccurrence[],
  next: LearningOccurrence,
): LearningOccurrence[] {
  if (existing.some((item) => item.key === next.key)) return [...existing];
  return [...existing, next]
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
    .slice(-MAX_OCCURRENCES);
}

function inWindow(iso: string, now: Date, windowDays: number): boolean {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return false;
  return time >= now.getTime() - windowDays * 86_400_000;
}

function uniqueTaskIds(occurrences: readonly LearningOccurrence[]): string[] {
  const ids: string[] = [];
  for (const item of occurrences) {
    if (!ids.includes(item.taskId)) ids.push(item.taskId);
  }
  return ids;
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}
