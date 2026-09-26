/**
 * Failure fingerprint inputs (SPEC §10.1).
 * Hash covers workflow, step, skills, specialists, error class, and field tag.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { redactSecrets } from "../../security/redact.js";

export const LEARNING_SOURCES = ["review_gate", "implementation", "review"] as const;

export type LearningSource = (typeof LEARNING_SOURCES)[number];

export const LearningObservationSchema = z.object({
  workflowId: z.string().min(1).optional(),
  stepId: z.string().min(1),
  skillIds: z.array(z.string()).optional(),
  specialistIds: z.array(z.string()).optional(),
  errorClass: z.string().min(1),
  field: z.string().min(1).optional(),
  taskId: z.string().min(1),
  sessionId: z.string().min(1),
  excerpt: z.string().optional(),
  source: z.enum(LEARNING_SOURCES),
  attempt: z.number().int().positive().optional(),
  occurredAt: z.string().optional(),
});

export type LearningObservationInput = z.input<typeof LearningObservationSchema>;

export interface LearningSink {
  record(observation: LearningObservationInput): Promise<void>;
}

export interface NormalizedObservation {
  workflowId: string;
  stepId: string;
  skillIds: string[];
  specialistIds: string[];
  errorClass: string;
  field: string;
  taskId: string;
  sessionId: string;
  excerpt: string;
  source: LearningSource;
  attempt: number;
  occurredAt: string;
  occurrenceKey: string;
}

export interface FingerprintParts {
  workflowId: string;
  stepId: string;
  skillIds: readonly string[];
  specialistIds: readonly string[];
  errorClass: string;
  field: string;
}

export function failureFingerprint(parts: FingerprintParts): string {
  const body = [
    parts.workflowId,
    parts.stepId,
    [...parts.skillIds]
      .map((id) => id.trim())
      .sort()
      .join(","),
    [...parts.specialistIds]
      .map((id) => id.trim())
      .sort()
      .join(","),
    parts.errorClass,
    parts.field,
  ].join("\n");
  return createHash("sha256").update(body).digest("hex");
}

export function redactExcerpt(raw: string): string {
  return redactSecrets(raw).replace(/\s+/g, " ").trim().slice(0, 500);
}

export function normalizeObservation(input: unknown, now: Date): NormalizedObservation {
  const parsed = LearningObservationSchema.parse(input);
  const workflowId = (parsed.workflowId ?? "default-task").trim().slice(0, 80);
  const stepId = parsed.stepId.trim().slice(0, 80);
  const errorClass = parsed.errorClass.trim().toLowerCase().replace(/\s+/g, "_").slice(0, 80);
  const field = normalizeField(parsed.field);
  const skillIds = normalizeIds(parsed.skillIds);
  const specialistIds = normalizeIds(parsed.specialistIds);
  const attempt = parsed.attempt ?? 1;
  const occurredAt = parsed.occurredAt ?? now.toISOString();
  if (Number.isNaN(Date.parse(occurredAt))) {
    throw new Error("invalid learning occurredAt");
  }
  if (!workflowId || !stepId || !errorClass) {
    throw new Error("invalid learning observation");
  }
  const source = parsed.source;
  return {
    workflowId,
    stepId,
    skillIds,
    specialistIds,
    errorClass,
    field,
    taskId: parsed.taskId.trim(),
    sessionId: parsed.sessionId.trim(),
    excerpt: redactExcerpt(parsed.excerpt ?? ""),
    source,
    attempt,
    occurredAt: new Date(occurredAt).toISOString(),
    occurrenceKey: [
      parsed.taskId.trim(),
      parsed.sessionId.trim(),
      source,
      String(attempt),
      errorClass,
      stepId,
    ].join("|"),
  };
}

function normalizeField(field: string | undefined): string {
  const cleaned = (field ?? "general").trim().toLowerCase().replace(/\s+/g, "-").slice(0, 64);
  return cleaned || "general";
}

function normalizeIds(ids: readonly string[] | undefined): string[] {
  const unique = new Set<string>();
  for (const id of ids ?? []) {
    const cleaned = id.trim();
    if (cleaned) unique.add(cleaned);
  }
  return [...unique].sort();
}
