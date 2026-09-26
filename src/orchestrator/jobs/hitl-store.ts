/**
 * Durable human-approval rows and planner confidence signals (issue #86).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SqlExecutor } from "./cursor.js";
import {
  HITL_POINTS,
  HITL_SOURCES,
  HITL_STATUSES,
  type HitlPoint,
  type HitlRecord,
  type HitlSignalStore,
  type HitlSource,
  type HitlStatus,
  type HitlStore,
} from "./hitl.js";

const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../state/migrations/002_hitl_approval.sql",
);

export function loadHitlApprovalDdl(): string {
  return readFileSync(MIGRATION, "utf8");
}

function approvalKey(taskId: string, sessionId: string, point: HitlPoint): string {
  return `${taskId}|${sessionId}|${point}`;
}

export class InMemoryHitlStore implements HitlStore, HitlSignalStore {
  private readonly approvals = new Map<string, HitlRecord>();
  private readonly signals = new Map<string, number>();

  async get(taskId: string, sessionId: string, point: HitlPoint): Promise<HitlRecord | undefined> {
    const found = this.approvals.get(approvalKey(taskId, sessionId, point));
    return found ? { ...found } : undefined;
  }

  async save(record: HitlRecord): Promise<void> {
    this.approvals.set(approvalKey(record.taskId, record.sessionId, record.point), { ...record });
  }

  async delete(taskId: string, sessionId: string, point: HitlPoint): Promise<void> {
    this.approvals.delete(approvalKey(taskId, sessionId, point));
  }

  async list(taskId: string, sessionId: string): Promise<HitlRecord[]> {
    const rows: HitlRecord[] = [];
    for (const point of HITL_POINTS) {
      const found = await this.get(taskId, sessionId, point);
      if (found) rows.push(found);
    }
    return rows;
  }

  async note(signal: {
    taskId: string;
    sessionId: string;
    point: HitlPoint;
    confidence: number;
  }): Promise<void> {
    if (!inUnitInterval(signal.confidence)) return;
    this.signals.set(approvalKey(signal.taskId, signal.sessionId, signal.point), signal.confidence);
  }

  async read(taskId: string, sessionId: string, point: HitlPoint): Promise<number | undefined> {
    return this.signals.get(approvalKey(taskId, sessionId, point));
  }
}

function inUnitInterval(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

export const UPSERT_HITL_SQL = `INSERT INTO hitl_approval (
  task_id, session_id, point, status, confidence, reason, source,
  requested_at, decided_at, notified_at, timeout_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
ON CONFLICT (task_id, session_id, point)
DO UPDATE SET
  status = EXCLUDED.status,
  confidence = EXCLUDED.confidence,
  reason = EXCLUDED.reason,
  source = EXCLUDED.source,
  requested_at = EXCLUDED.requested_at,
  decided_at = EXCLUDED.decided_at,
  notified_at = EXCLUDED.notified_at,
  timeout_at = EXCLUDED.timeout_at`;

export const SELECT_HITL_SQL = `SELECT
  task_id, session_id, point, status, confidence, reason, source,
  requested_at, decided_at, notified_at, timeout_at
FROM hitl_approval
WHERE task_id = $1 AND session_id = $2 AND point = $3`;

export const SELECT_HITL_LIST_SQL = `SELECT
  task_id, session_id, point, status, confidence, reason, source,
  requested_at, decided_at, notified_at, timeout_at
FROM hitl_approval
WHERE task_id = $1 AND session_id = $2
ORDER BY point`;

export const DELETE_HITL_SQL = `DELETE FROM hitl_approval
WHERE task_id = $1 AND session_id = $2 AND point = $3`;

export const UPSERT_HITL_SIGNAL_SQL = `INSERT INTO hitl_signal (
  task_id, session_id, point, confidence, updated_at
) VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (task_id, session_id, point)
DO UPDATE SET confidence = EXCLUDED.confidence, updated_at = EXCLUDED.updated_at`;

export const SELECT_HITL_SIGNAL_SQL = `SELECT confidence
FROM hitl_signal
WHERE task_id = $1 AND session_id = $2 AND point = $3`;

function isPoint(value: string): value is HitlPoint {
  return (HITL_POINTS as readonly string[]).includes(value);
}

function isStatus(value: string): value is HitlStatus {
  return (HITL_STATUSES as readonly string[]).includes(value);
}

function isSource(value: string): value is HitlSource {
  return (HITL_SOURCES as readonly string[]).includes(value);
}

function readTimestamp(value: unknown, label: string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`invalid hitl ${label}`);
}

function readOptionalTimestamp(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return readTimestamp(value, "timestamp");
}

function readOptionalConfidence(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) throw new Error("invalid hitl confidence");
  return parsed;
}

function rowToRecord(row: Record<string, unknown>): HitlRecord {
  const point = row.point;
  const status = row.status;
  const source = row.source;
  if (typeof point !== "string" || !isPoint(point)) throw new Error("invalid hitl point");
  if (typeof status !== "string" || !isStatus(status)) throw new Error("invalid hitl status");
  if (typeof source !== "string" || !isSource(source)) throw new Error("invalid hitl source");
  if (typeof row.task_id !== "string" || typeof row.session_id !== "string") {
    throw new Error("invalid hitl identity");
  }
  if (typeof row.reason !== "string") throw new Error("invalid hitl reason");
  const confidence = readOptionalConfidence(row.confidence);
  const decidedAt = readOptionalTimestamp(row.decided_at);
  const notifiedAt = readOptionalTimestamp(row.notified_at);
  return {
    taskId: row.task_id,
    sessionId: row.session_id,
    point,
    status,
    ...(confidence !== undefined ? { confidence } : {}),
    reason: row.reason,
    source,
    requestedAt: readTimestamp(row.requested_at, "requested_at"),
    ...(decidedAt ? { decidedAt } : {}),
    ...(notifiedAt ? { notifiedAt } : {}),
    timeoutAt: readTimestamp(row.timeout_at, "timeout_at"),
  };
}

function recordParams(record: HitlRecord): unknown[] {
  return [
    record.taskId,
    record.sessionId,
    record.point,
    record.status,
    record.confidence ?? null,
    record.reason,
    record.source,
    record.requestedAt,
    record.decidedAt ?? null,
    record.notifiedAt ?? null,
    record.timeoutAt,
  ];
}

export function createSqlHitlStore(db: SqlExecutor): HitlStore & HitlSignalStore {
  return {
    async get(taskId, sessionId, point) {
      const result = await db.query(SELECT_HITL_SQL, [taskId, sessionId, point]);
      const row = result.rows[0];
      return row ? rowToRecord(row) : undefined;
    },
    async save(record) {
      await db.query(UPSERT_HITL_SQL, recordParams(record));
    },
    async delete(taskId, sessionId, point) {
      await db.query(DELETE_HITL_SQL, [taskId, sessionId, point]);
    },
    async list(taskId, sessionId) {
      const result = await db.query(SELECT_HITL_LIST_SQL, [taskId, sessionId]);
      return result.rows.map((row) => rowToRecord(row));
    },
    async note(signal) {
      if (!inUnitInterval(signal.confidence)) return;
      await db.query(UPSERT_HITL_SIGNAL_SQL, [
        signal.taskId,
        signal.sessionId,
        signal.point,
        signal.confidence,
        new Date().toISOString(),
      ]);
    },
    async read(taskId, sessionId, point) {
      const result = await db.query(SELECT_HITL_SIGNAL_SQL, [taskId, sessionId, point]);
      const row = result.rows[0];
      if (!row) return undefined;
      return readOptionalConfidence(row.confidence);
    },
  };
}

export async function createPgHitlStore(
  connectionString: string,
): Promise<HitlStore & HitlSignalStore & { close(): Promise<void> }> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString });
  const db: SqlExecutor = {
    async query(sql, params) {
      const result = await pool.query(sql, params as unknown[] | undefined);
      return { rows: result.rows as Record<string, unknown>[] };
    },
  };
  await db.query(loadHitlApprovalDdl());
  const store = createSqlHitlStore(db);
  return {
    get: (taskId, sessionId, point) => store.get(taskId, sessionId, point),
    save: (record) => store.save(record),
    delete: (taskId, sessionId, point) => store.delete(taskId, sessionId, point),
    list: (taskId, sessionId) => store.list(taskId, sessionId),
    note: (signal) => store.note(signal),
    read: (taskId, sessionId, point) => store.read(taskId, sessionId, point),
    close: () => pool.end(),
  };
}
