/**
 * Learnings table. Postgres is the runtime store; unit tests use memory or a SQL executor.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LearningSource } from "./observation.js";

export interface LearningOccurrence {
  key: string;
  taskId: string;
  sessionId: string;
  source: LearningSource;
  attempt: number;
  occurredAt: string;
  excerpt: string;
}

export interface LearningRecord {
  fingerprint: string;
  workflowId: string;
  stepId: string;
  skillIds: string[];
  specialistIds: string[];
  errorClass: string;
  field: string;
  occurrences: LearningOccurrence[];
  hitCount: number;
  status: "observed" | "proposed";
  excerpt: string;
  sampleTaskIds: string[];
  proposalBody: string | null;
  /** Budget proposal for the planner. Not applied to review-gate or skill allow-lists. */
  recommendation: string | null;
  metaIssueUrl: string | null;
  updatedAt: string;
}

export interface LearningStore {
  get(fingerprint: string): Promise<LearningRecord | undefined>;
  save(record: LearningRecord): Promise<void>;
  listByField(field: string, limit: number): Promise<LearningRecord[]>;
}

export interface SqlExecutor {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export function resolveLearningsMigrationPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "../../../state/migrations/002_learnings.sql"),
    join(here, "../state/migrations/002_learnings.sql"),
    join(process.cwd(), "state/migrations/002_learnings.sql"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("missing state/migrations/002_learnings.sql");
}

export function loadLearningsDdl(): string {
  return readFileSync(resolveLearningsMigrationPath(), "utf8");
}

export class InMemoryLearningStore implements LearningStore {
  private readonly rows = new Map<string, LearningRecord>();

  async get(fingerprint: string): Promise<LearningRecord | undefined> {
    const found = this.rows.get(fingerprint);
    return found ? structuredClone(found) : undefined;
  }

  async save(record: LearningRecord): Promise<void> {
    this.rows.set(record.fingerprint, structuredClone(record));
  }

  async listByField(field: string, limit: number): Promise<LearningRecord[]> {
    return [...this.rows.values()]
      .filter((row) => row.field === field)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map((row) => structuredClone(row));
  }
}

export const UPSERT_LEARNING_SQL = `INSERT INTO learnings (
  fingerprint, workflow_id, step_id, skill_ids, specialist_ids, error_class, field_tag,
  occurrences, hit_count, status, excerpt, sample_task_ids, proposal_body, recommendation, meta_issue_url, updated_at
) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8::jsonb, $9, $10, $11, $12::jsonb, $13, $14, $15, $16)
ON CONFLICT (fingerprint) DO UPDATE SET
  workflow_id = EXCLUDED.workflow_id,
  step_id = EXCLUDED.step_id,
  skill_ids = EXCLUDED.skill_ids,
  specialist_ids = EXCLUDED.specialist_ids,
  error_class = EXCLUDED.error_class,
  field_tag = EXCLUDED.field_tag,
  occurrences = EXCLUDED.occurrences,
  hit_count = EXCLUDED.hit_count,
  status = EXCLUDED.status,
  excerpt = EXCLUDED.excerpt,
  sample_task_ids = EXCLUDED.sample_task_ids,
  proposal_body = EXCLUDED.proposal_body,
  recommendation = EXCLUDED.recommendation,
  meta_issue_url = EXCLUDED.meta_issue_url,
  updated_at = EXCLUDED.updated_at`;

export const SELECT_LEARNING_BY_FINGERPRINT_SQL = `SELECT fingerprint, workflow_id, step_id, skill_ids, specialist_ids, error_class, field_tag, occurrences, hit_count, status, excerpt, sample_task_ids, proposal_body, recommendation, meta_issue_url, updated_at
FROM learnings WHERE fingerprint = $1`;

export const LIST_LEARNINGS_BY_FIELD_SQL = `SELECT fingerprint, workflow_id, step_id, skill_ids, specialist_ids, error_class, field_tag, occurrences, hit_count, status, excerpt, sample_task_ids, proposal_body, recommendation, meta_issue_url, updated_at
FROM learnings WHERE field_tag = $1 ORDER BY updated_at DESC LIMIT $2`;

export function createSqlLearningStore(db: SqlExecutor): LearningStore {
  return {
    async get(fingerprint) {
      const result = await db.query(SELECT_LEARNING_BY_FINGERPRINT_SQL, [fingerprint]);
      const row = result.rows[0];
      return row ? rowToLearning(row) : undefined;
    },
    async save(record) {
      await db.query(UPSERT_LEARNING_SQL, toParams(record));
    },
    async listByField(field, limit) {
      const result = await db.query(LIST_LEARNINGS_BY_FIELD_SQL, [field, limit]);
      return result.rows.map(rowToLearning);
    },
  };
}

export async function createPgLearningStore(
  connectionString: string,
): Promise<LearningStore & { close(): Promise<void> }> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString });
  const db: SqlExecutor = {
    async query(sql, params) {
      const result = await pool.query(sql, params as unknown[] | undefined);
      return { rows: result.rows as Record<string, unknown>[] };
    },
  };
  await db.query(loadLearningsDdl());
  const store = createSqlLearningStore(db);
  return {
    get: (fingerprint) => store.get(fingerprint),
    save: (record) => store.save(record),
    listByField: (field, limit) => store.listByField(field, limit),
    close: () => pool.end(),
  };
}

function toParams(record: LearningRecord): unknown[] {
  return [
    record.fingerprint,
    record.workflowId,
    record.stepId,
    JSON.stringify(record.skillIds),
    JSON.stringify(record.specialistIds),
    record.errorClass,
    record.field,
    JSON.stringify(record.occurrences),
    record.hitCount,
    record.status,
    record.excerpt,
    JSON.stringify(record.sampleTaskIds),
    record.proposalBody,
    record.recommendation,
    record.metaIssueUrl,
    record.updatedAt,
  ];
}

function rowToLearning(row: Record<string, unknown>): LearningRecord {
  const status = row.status;
  if (status !== "observed" && status !== "proposed") {
    throw new Error(`invalid learning status: ${String(status)}`);
  }
  if (typeof row.fingerprint !== "string" || typeof row.field_tag !== "string") {
    throw new Error("invalid learning row");
  }
  return {
    fingerprint: row.fingerprint,
    workflowId: readString(row.workflow_id, "workflow_id"),
    stepId: readString(row.step_id, "step_id"),
    skillIds: readJson<string[]>(row.skill_ids, []),
    specialistIds: readJson<string[]>(row.specialist_ids, []),
    errorClass: readString(row.error_class, "error_class"),
    field: row.field_tag,
    occurrences: readJson<LearningOccurrence[]>(row.occurrences, []),
    hitCount: readCount(row.hit_count),
    status,
    excerpt: readString(row.excerpt, "excerpt"),
    sampleTaskIds: readJson<string[]>(row.sample_task_ids, []),
    proposalBody: readNullableString(row.proposal_body),
    recommendation: readNullableString(row.recommendation),
    metaIssueUrl: readNullableString(row.meta_issue_url),
    updatedAt: readTimestamp(row.updated_at),
  };
}

function readString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`invalid learning ${name}`);
  return value;
}

function readNullableString(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new Error("invalid learning text");
  return value;
}

function readCount(value: unknown): number {
  const count = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(count) || count < 0) throw new Error("invalid learning hit_count");
  return count;
}

function readTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) return new Date(value).toISOString();
  throw new Error("invalid learning updated_at");
}

function readJson<T>(value: unknown, fallback: T): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  if (value === undefined || value === null) return fallback;
  return value as T;
}
