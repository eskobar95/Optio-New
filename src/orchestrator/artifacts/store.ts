/**
 * Session artifact trail. Postgres is the runtime store; unit tests use memory or a SQL executor.
 * One row per stage. Bodies stay small so the CX33 disk is not the log archive.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PIPELINE_STAGES, type PipelineStage } from "../jobs/stages.js";

export const ARTIFACT_OUTCOMES = ["completed", "failed"] as const;

export type ArtifactOutcome = (typeof ARTIFACT_OUTCOMES)[number];

export interface SessionArtifact {
  taskId: string;
  sessionId: string;
  stage: PipelineStage;
  outcome: ArtifactOutcome;
  body: string;
  planText: string | null;
  prUrl: string | null;
  errorMessage: string | null;
  updatedAt: string;
}

export interface SessionArtifactStore {
  upsert(artifact: SessionArtifact): Promise<void>;
  list(taskId: string, sessionId: string): Promise<SessionArtifact[]>;
  /** Drop rows older than `cutoff` and then keep only the newest `maxRows`. Returns rows removed. */
  prune(cutoffIso: string, maxRows: number): Promise<number>;
}

export interface ArtifactSql {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export function resolveSessionArtifactsMigrationPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "../../../state/migrations/004_session_artifacts.sql"),
    join(here, "../state/migrations/004_session_artifacts.sql"),
    join(process.cwd(), "state/migrations/004_session_artifacts.sql"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("missing state/migrations/004_session_artifacts.sql");
}

export function loadSessionArtifactsDdl(): string {
  return readFileSync(resolveSessionArtifactsMigrationPath(), "utf8");
}

function artifactKey(taskId: string, sessionId: string, stage: PipelineStage): string {
  return `${taskId}|${sessionId}|${stage}`;
}

export class InMemorySessionArtifactStore implements SessionArtifactStore {
  private readonly rows = new Map<string, SessionArtifact>();

  async upsert(artifact: SessionArtifact): Promise<void> {
    this.rows.set(artifactKey(artifact.taskId, artifact.sessionId, artifact.stage), {
      ...artifact,
    });
  }

  async list(taskId: string, sessionId: string): Promise<SessionArtifact[]> {
    return [...this.rows.values()]
      .filter((row) => row.taskId === taskId && row.sessionId === sessionId)
      .map((row) => ({ ...row }))
      .sort((a, b) => PIPELINE_STAGES.indexOf(a.stage) - PIPELINE_STAGES.indexOf(b.stage));
  }

  async prune(cutoffIso: string, maxRows: number): Promise<number> {
    const before = this.rows.size;
    for (const [key, row] of this.rows) {
      if (row.updatedAt < cutoffIso) this.rows.delete(key);
    }
    const ranked = [...this.rows.entries()].sort((a, b) =>
      b[1].updatedAt.localeCompare(a[1].updatedAt),
    );
    for (const [key] of ranked.slice(Math.max(0, maxRows))) {
      this.rows.delete(key);
    }
    return before - this.rows.size;
  }
}

export const UPSERT_SESSION_ARTIFACT_SQL = `INSERT INTO session_artifacts (
  task_id, session_id, stage, outcome, body, plan_text, pr_url, error_message, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (task_id, session_id, stage) DO UPDATE SET
  outcome = EXCLUDED.outcome,
  body = EXCLUDED.body,
  plan_text = EXCLUDED.plan_text,
  pr_url = EXCLUDED.pr_url,
  error_message = EXCLUDED.error_message,
  updated_at = EXCLUDED.updated_at`;

export const LIST_SESSION_ARTIFACTS_SQL = `SELECT task_id, session_id, stage, outcome, body, plan_text, pr_url, error_message, updated_at
FROM session_artifacts
WHERE task_id = $1 AND session_id = $2`;

export const PRUNE_SESSION_ARTIFACTS_BY_AGE_SQL = `DELETE FROM session_artifacts
WHERE updated_at < $1
RETURNING task_id`;

export const PRUNE_SESSION_ARTIFACTS_BY_COUNT_SQL = `DELETE FROM session_artifacts
WHERE ctid IN (
  SELECT ctid FROM session_artifacts
  ORDER BY updated_at DESC
  OFFSET $1
)
RETURNING task_id`;

function isStage(value: string): value is PipelineStage {
  return (PIPELINE_STAGES as readonly string[]).includes(value);
}

function isOutcome(value: string): value is ArtifactOutcome {
  return (ARTIFACT_OUTCOMES as readonly string[]).includes(value);
}

function readText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("invalid session artifact text");
  return value;
}

function readTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error("invalid session artifact updated_at");
}

function rowToArtifact(row: Record<string, unknown>): SessionArtifact {
  const stage = row.stage;
  const outcome = row.outcome;
  if (typeof stage !== "string" || !isStage(stage)) {
    throw new Error(`invalid session artifact stage: ${String(stage)}`);
  }
  if (typeof outcome !== "string" || !isOutcome(outcome)) {
    throw new Error(`invalid session artifact outcome: ${String(outcome)}`);
  }
  if (typeof row.task_id !== "string" || typeof row.session_id !== "string") {
    throw new Error("invalid session artifact identity");
  }
  if (typeof row.body !== "string") throw new Error("invalid session artifact body");
  return {
    taskId: row.task_id,
    sessionId: row.session_id,
    stage,
    outcome,
    body: row.body,
    planText: readText(row.plan_text),
    prUrl: readText(row.pr_url),
    errorMessage: readText(row.error_message),
    updatedAt: readTimestamp(row.updated_at),
  };
}

export function createSqlSessionArtifactStore(db: ArtifactSql): SessionArtifactStore {
  return {
    async upsert(artifact) {
      await db.query(UPSERT_SESSION_ARTIFACT_SQL, [
        artifact.taskId,
        artifact.sessionId,
        artifact.stage,
        artifact.outcome,
        artifact.body,
        artifact.planText,
        artifact.prUrl,
        artifact.errorMessage,
        artifact.updatedAt,
      ]);
    },
    async list(taskId, sessionId) {
      const result = await db.query(LIST_SESSION_ARTIFACTS_SQL, [taskId, sessionId]);
      return result.rows
        .map((row) => rowToArtifact(row))
        .sort((a, b) => PIPELINE_STAGES.indexOf(a.stage) - PIPELINE_STAGES.indexOf(b.stage));
    },
    async prune(cutoffIso, maxRows) {
      const aged = await db.query(PRUNE_SESSION_ARTIFACTS_BY_AGE_SQL, [cutoffIso]);
      const capped = await db.query(PRUNE_SESSION_ARTIFACTS_BY_COUNT_SQL, [maxRows]);
      return aged.rows.length + capped.rows.length;
    },
  };
}
