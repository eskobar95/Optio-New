/**
 * Durable step cursor. Postgres is the runtime store; unit tests use memory or a SQL executor.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PIPELINE_STAGES, type PipelineStage } from "./stages.js";

export const STEP_CURSOR_STATUSES = ["pending", "running", "completed", "failed"] as const;

export type StepCursorStatus = (typeof STEP_CURSOR_STATUSES)[number];

export interface StepCursor {
  taskId: string;
  sessionId: string;
  stage: PipelineStage;
  nextStepIndex: number;
  status: StepCursorStatus;
  updatedAt: string;
}

export interface StepCursorStore {
  get(taskId: string, sessionId: string, stage: PipelineStage): Promise<StepCursor | undefined>;
  save(cursor: StepCursor): Promise<void>;
}

export interface SqlExecutor {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const MIGRATION_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../state/migrations/001_pipeline_step_cursor.sql",
);

export function loadPipelineStepCursorDdl(): string {
  return readFileSync(MIGRATION_FILE, "utf8");
}

function cursorKey(taskId: string, sessionId: string, stage: PipelineStage): string {
  return `${taskId}|${sessionId}|${stage}`;
}

export class InMemoryStepCursorStore implements StepCursorStore {
  private readonly rows = new Map<string, StepCursor>();

  async get(
    taskId: string,
    sessionId: string,
    stage: PipelineStage,
  ): Promise<StepCursor | undefined> {
    const found = this.rows.get(cursorKey(taskId, sessionId, stage));
    return found ? { ...found } : undefined;
  }

  async save(cursor: StepCursor): Promise<void> {
    this.rows.set(cursorKey(cursor.taskId, cursor.sessionId, cursor.stage), { ...cursor });
  }
}

export const UPSERT_STEP_CURSOR_SQL = `INSERT INTO pipeline_step_cursor (task_id, session_id, stage, next_step_index, status, updated_at)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (task_id, session_id, stage)
DO UPDATE SET
  next_step_index = EXCLUDED.next_step_index,
  status = EXCLUDED.status,
  updated_at = EXCLUDED.updated_at`;

export const SELECT_STEP_CURSOR_SQL = `SELECT task_id, session_id, stage, next_step_index, status, updated_at
FROM pipeline_step_cursor
WHERE task_id = $1 AND session_id = $2 AND stage = $3`;

function isStage(value: string): value is PipelineStage {
  return (PIPELINE_STAGES as readonly string[]).includes(value);
}

function isStatus(value: string): value is StepCursorStatus {
  return (STEP_CURSOR_STATUSES as readonly string[]).includes(value);
}

function readIndex(value: unknown): number {
  const index = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("invalid step cursor next_step_index");
  }
  return index;
}

function readTimestamp(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  throw new Error("invalid step cursor updated_at");
}

function rowToCursor(row: Record<string, unknown>): StepCursor {
  const stage = row.stage;
  const status = row.status;
  if (typeof stage !== "string" || !isStage(stage)) {
    throw new Error(`invalid step cursor stage: ${String(stage)}`);
  }
  if (typeof status !== "string" || !isStatus(status)) {
    throw new Error(`invalid step cursor status: ${String(status)}`);
  }
  if (typeof row.task_id !== "string" || typeof row.session_id !== "string") {
    throw new Error("invalid step cursor identity");
  }
  return {
    taskId: row.task_id,
    sessionId: row.session_id,
    stage,
    nextStepIndex: readIndex(row.next_step_index),
    status,
    updatedAt: readTimestamp(row.updated_at),
  };
}

export function createSqlStepCursorStore(db: SqlExecutor): StepCursorStore {
  return {
    async get(taskId, sessionId, stage) {
      const result = await db.query(SELECT_STEP_CURSOR_SQL, [taskId, sessionId, stage]);
      const row = result.rows[0];
      return row ? rowToCursor(row) : undefined;
    },
    async save(cursor) {
      await db.query(UPSERT_STEP_CURSOR_SQL, [
        cursor.taskId,
        cursor.sessionId,
        cursor.stage,
        cursor.nextStepIndex,
        cursor.status,
        cursor.updatedAt,
      ]);
    },
  };
}

export async function createPgStepCursorStore(
  connectionString: string,
): Promise<StepCursorStore & { close(): Promise<void> }> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString });
  const db: SqlExecutor = {
    async query(sql, params) {
      const result = await pool.query(sql, params as unknown[] | undefined);
      return { rows: result.rows as Record<string, unknown>[] };
    },
  };
  await db.query(loadPipelineStepCursorDdl());
  const store = createSqlStepCursorStore(db);
  return {
    get: (taskId, sessionId, stage) => store.get(taskId, sessionId, stage),
    save: (cursor) => store.save(cursor),
    close: () => pool.end(),
  };
}
