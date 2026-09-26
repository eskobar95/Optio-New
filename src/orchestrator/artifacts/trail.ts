/**
 * Build and read the per-task artifact trail.
 * CX33 is 4 shared vCPU, 8 GB RAM, and 80 GB NVMe shared with the OS, images,
 * Postgres, Redis, and worktrees. The trail is one small row per stage, not a log archive.
 */
import type { PipelineStage } from "../jobs/stages.js";
import { PIPELINE_STAGES } from "../jobs/stages.js";
import type { ArtifactOutcome, SessionArtifact, SessionArtifactStore } from "./store.js";

/** 14 days, 16 KiB per text field, 2000 rows (~32 MB at the cap). */
export const DEFAULT_ARTIFACT_LIMITS = {
  retentionDays: 14,
  maxBytes: 16 * 1024,
  maxRows: 2000,
} as const;

export interface ArtifactLimits {
  retentionDays: number;
  maxBytes: number;
  maxRows: number;
}

const TRUNCATED = "\n[truncated]";

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function readArtifactLimits(env: NodeJS.ProcessEnv = process.env): ArtifactLimits {
  return {
    retentionDays: clampInt(
      env.OPTIO_NEW_ARTIFACT_RETENTION_DAYS,
      DEFAULT_ARTIFACT_LIMITS.retentionDays,
      1,
      90,
    ),
    maxBytes: clampInt(
      env.OPTIO_NEW_ARTIFACT_MAX_BYTES,
      DEFAULT_ARTIFACT_LIMITS.maxBytes,
      256,
      65_536,
    ),
    maxRows: clampInt(env.OPTIO_NEW_ARTIFACT_MAX_ROWS, DEFAULT_ARTIFACT_LIMITS.maxRows, 10, 20_000),
  };
}

export function capText(value: string, maxBytes: number): string {
  const buf = Buffer.from(value, "utf8");
  if (buf.length <= maxBytes) return value;
  const marker = Buffer.from(TRUNCATED, "utf8");
  const budget = Math.max(0, maxBytes - marker.length);
  let end = budget;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return `${buf.subarray(0, end).toString("utf8")}${TRUNCATED}`;
}

export function renderStageArtifactBody(input: {
  stage: PipelineStage;
  outcome: ArtifactOutcome;
  planText: string | null;
  prUrl: string | null;
  errorMessage: string | null;
}): string {
  const lines = [`# ${input.stage}`, `outcome: ${input.outcome}`];
  if (input.planText) lines.push("", "## plan", input.planText);
  if (input.prUrl) lines.push("", `pr: ${input.prUrl}`);
  if (input.errorMessage) lines.push("", "## error", input.errorMessage);
  return lines.join("\n");
}

export function buildSessionArtifact(input: {
  taskId: string;
  sessionId: string;
  stage: PipelineStage;
  outcome: ArtifactOutcome;
  planText: string | null;
  prUrl: string | null;
  errorMessage: string | null;
  updatedAt: string;
  limits: ArtifactLimits;
}): SessionArtifact {
  const planText = input.planText ? capText(input.planText, input.limits.maxBytes) : null;
  const prUrl = input.prUrl ? capText(input.prUrl, input.limits.maxBytes) : null;
  const errorMessage = input.errorMessage
    ? capText(input.errorMessage, input.limits.maxBytes)
    : null;
  const body = capText(
    renderStageArtifactBody({
      stage: input.stage,
      outcome: input.outcome,
      planText,
      prUrl,
      errorMessage,
    }),
    input.limits.maxBytes,
  );
  return {
    taskId: input.taskId,
    sessionId: input.sessionId,
    stage: input.stage,
    outcome: input.outcome,
    body,
    planText,
    prUrl,
    errorMessage,
    updatedAt: input.updatedAt,
  };
}

export interface SessionArtifactTrail {
  taskId: string;
  sessionId: string;
  planText: string | null;
  prUrl: string | null;
  lastError: string | null;
  artifacts: SessionArtifact[];
}

export async function dumpSessionArtifactTrail(
  store: SessionArtifactStore,
  taskId: string,
  sessionId: string,
): Promise<SessionArtifactTrail> {
  const artifacts = await store.list(taskId, sessionId);
  const plan = artifacts.find((row) => row.stage === "plan" && row.planText);
  const pr = [...artifacts].reverse().find((row) => row.prUrl);
  const failed = [...artifacts]
    .reverse()
    .find((row) => row.outcome === "failed" && row.errorMessage);
  return {
    taskId,
    sessionId,
    planText: plan?.planText ?? null,
    prUrl: pr?.prUrl ?? null,
    lastError: failed?.errorMessage ?? null,
    artifacts,
  };
}

export function artifactCutoffIso(retentionDays: number, now = Date.now()): string {
  return new Date(now - retentionDays * 86_400_000).toISOString();
}

export function stageIndex(stage: PipelineStage): number {
  return PIPELINE_STAGES.indexOf(stage);
}
