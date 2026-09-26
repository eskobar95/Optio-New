/**
 * Queryable stage timing, adapter usage, and agent actions for one task.
 * Postgres is the runtime store; unit tests use memory or a SQL executor.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PIPELINE_STAGES, type PipelineStage } from "../jobs/stages.js";

export type StageRunStatus = "running" | "completed" | "failed";

export interface StageUsageEntry {
  agentId: string;
  provider?: string;
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  costUsd?: number;
}

export interface AgentActionEntry {
  at: string;
  sessionId: string;
  stage: PipelineStage;
  step: string;
  agentId: string;
  name: string;
  status: "ok" | "error";
  reason?: string;
}

export interface StageRunRecord {
  taskId: string;
  sessionId: string;
  stage: PipelineStage;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status: StageRunStatus;
  reason?: string;
  usage: StageUsageEntry[];
  actions: AgentActionEntry[];
}

export interface StageRunView {
  sessionId: string;
  stage: PipelineStage;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status: StageRunStatus;
  reason?: string;
  usage: StageUsageEntry[];
  actions: AgentActionEntry[];
}

export interface TaskRunView {
  taskId: string;
  stages: StageRunView[];
}

/** Numbers an adapter actually reported. Provider alone is not usage. */
export interface StageUsageReport {
  agentId: string;
  provider?: string;
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  costUsd?: number;
}

export interface StageRunStore {
  get(taskId: string, sessionId: string, stage: PipelineStage): Promise<StageRunRecord | undefined>;
  save(record: StageRunRecord): Promise<void>;
  listByTask(taskId: string): Promise<StageRunRecord[]>;
}

export interface StageRunLog {
  beginStage(input: {
    taskId: string;
    sessionId: string;
    stage: PipelineStage;
    startedAt: string;
  }): Promise<{ startedAt: string }>;
  finishStage(input: {
    taskId: string;
    sessionId: string;
    stage: PipelineStage;
    endedAt: string;
    durationMs: number;
    status: "completed" | "failed";
    reason?: string;
  }): Promise<void>;
  recordAction(input: AgentActionEntry & { taskId: string }): Promise<void>;
  recordUsage(
    input: StageUsageReport & { taskId: string; sessionId: string; stage: PipelineStage },
  ): Promise<void>;
  inspect(taskId: string): Promise<TaskRunView>;
}

export interface SqlExecutor {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

function measured(entry: StageUsageReport): boolean {
  return [entry.inputTokens, entry.outputTokens, entry.cachedTokens, entry.costUsd].some(
    (value) => typeof value === "number" && Number.isFinite(value),
  );
}

function usageEntry(input: StageUsageReport): StageUsageEntry | undefined {
  if (!input.agentId || !measured(input)) return undefined;
  const entry: StageUsageEntry = { agentId: input.agentId };
  if (input.provider) entry.provider = input.provider;
  if (input.modelId) entry.modelId = input.modelId;
  if (typeof input.inputTokens === "number" && Number.isFinite(input.inputTokens)) {
    entry.inputTokens = input.inputTokens;
  }
  if (typeof input.outputTokens === "number" && Number.isFinite(input.outputTokens)) {
    entry.outputTokens = input.outputTokens;
  }
  if (typeof input.cachedTokens === "number" && Number.isFinite(input.cachedTokens)) {
    entry.cachedTokens = input.cachedTokens;
  }
  if (typeof input.costUsd === "number" && Number.isFinite(input.costUsd)) {
    entry.costUsd = input.costUsd;
  }
  return entry;
}

function mergeUsage(
  existing: readonly StageUsageEntry[],
  next: StageUsageEntry,
): StageUsageEntry[] {
  return [...existing.filter((row) => row.agentId !== next.agentId), next];
}

function toView(record: StageRunRecord): StageRunView {
  const view: StageRunView = {
    sessionId: record.sessionId,
    stage: record.stage,
    startedAt: record.startedAt,
    status: record.status,
    usage: record.usage.map((row) => ({ ...row })),
    actions: record.actions.map((row) => ({ ...row })),
  };
  if (record.endedAt) view.endedAt = record.endedAt;
  if (record.durationMs !== undefined) view.durationMs = record.durationMs;
  if (record.reason) view.reason = record.reason;
  return view;
}

function sortRuns(records: readonly StageRunRecord[]): StageRunRecord[] {
  return [...records].sort((left, right) => {
    const stage = PIPELINE_STAGES.indexOf(left.stage) - PIPELINE_STAGES.indexOf(right.stage);
    if (stage !== 0) return stage;
    return left.sessionId.localeCompare(right.sessionId);
  });
}

export function createStageRunLog(store: StageRunStore): StageRunLog {
  return {
    async beginStage(input) {
      const existing = await store.get(input.taskId, input.sessionId, input.stage);
      if (existing?.status === "completed") return { startedAt: existing.startedAt };
      if (existing) {
        const running: StageRunRecord = { ...existing, status: "running" };
        delete running.reason;
        await store.save(running);
        return { startedAt: existing.startedAt };
      }
      await store.save({
        taskId: input.taskId,
        sessionId: input.sessionId,
        stage: input.stage,
        startedAt: input.startedAt,
        status: "running",
        usage: [],
        actions: [],
      });
      return { startedAt: input.startedAt };
    },

    async finishStage(input) {
      const existing = await store.get(input.taskId, input.sessionId, input.stage);
      if (!existing || existing.status === "completed") return;
      const next: StageRunRecord = {
        ...existing,
        endedAt: input.endedAt,
        durationMs: input.durationMs,
        status: input.status,
      };
      if (input.status === "failed" && input.reason) next.reason = input.reason;
      else delete next.reason;
      await store.save(next);
    },

    async recordAction(input) {
      const existing = await store.get(input.taskId, input.sessionId, input.stage);
      if (!existing || existing.status === "completed") return;
      const action: AgentActionEntry = {
        at: input.at,
        sessionId: input.sessionId,
        stage: input.stage,
        step: input.step,
        agentId: input.agentId,
        name: input.name,
        status: input.status,
      };
      if (input.reason) action.reason = input.reason;
      await store.save({ ...existing, actions: [...existing.actions, action] });
    },

    async recordUsage(input) {
      const entry = usageEntry(input);
      if (!entry) return;
      const existing = await store.get(input.taskId, input.sessionId, input.stage);
      if (existing?.status === "completed") {
        await store.save({ ...existing, usage: mergeUsage(existing.usage, entry) });
        return;
      }
      if (!existing) {
        await store.save({
          taskId: input.taskId,
          sessionId: input.sessionId,
          stage: input.stage,
          startedAt: new Date().toISOString(),
          status: "running",
          usage: [entry],
          actions: [],
        });
        return;
      }
      await store.save({ ...existing, usage: mergeUsage(existing.usage, entry) });
    },

    async inspect(taskId) {
      const records = sortRuns(await store.listByTask(taskId));
      return { taskId, stages: records.map(toView) };
    },
  };
}

function keyOf(taskId: string, sessionId: string, stage: PipelineStage): string {
  return `${taskId}|${sessionId}|${stage}`;
}

export class InMemoryStageRunStore implements StageRunStore {
  private readonly rows = new Map<string, StageRunRecord>();

  async get(
    taskId: string,
    sessionId: string,
    stage: PipelineStage,
  ): Promise<StageRunRecord | undefined> {
    const found = this.rows.get(keyOf(taskId, sessionId, stage));
    return found ? structuredClone(found) : undefined;
  }

  async save(record: StageRunRecord): Promise<void> {
    this.rows.set(keyOf(record.taskId, record.sessionId, record.stage), structuredClone(record));
  }

  async listByTask(taskId: string): Promise<StageRunRecord[]> {
    return [...this.rows.values()]
      .filter((row) => row.taskId === taskId)
      .map((row) => structuredClone(row));
  }
}

export function resolveStageRunMigrationPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "../../../../state/migrations/003_pipeline_stage_run.sql"),
    join(here, "../../../state/migrations/003_pipeline_stage_run.sql"),
    join(process.cwd(), "state/migrations/003_pipeline_stage_run.sql"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("missing state/migrations/003_pipeline_stage_run.sql");
}

export function loadPipelineStageRunDdl(): string {
  return readFileSync(resolveStageRunMigrationPath(), "utf8");
}

export const UPSERT_STAGE_RUN_SQL = `INSERT INTO pipeline_stage_run (
  task_id, session_id, stage, started_at, ended_at, duration_ms, status, reason, usage, actions
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
ON CONFLICT (task_id, session_id, stage) DO UPDATE SET
  started_at = EXCLUDED.started_at,
  ended_at = EXCLUDED.ended_at,
  duration_ms = EXCLUDED.duration_ms,
  status = EXCLUDED.status,
  reason = EXCLUDED.reason,
  usage = EXCLUDED.usage,
  actions = EXCLUDED.actions`;

export const SELECT_STAGE_RUN_SQL = `SELECT task_id, session_id, stage, started_at, ended_at, duration_ms, status, reason, usage, actions
FROM pipeline_stage_run
WHERE task_id = $1 AND session_id = $2 AND stage = $3`;

export const LIST_STAGE_RUNS_SQL = `SELECT task_id, session_id, stage, started_at, ended_at, duration_ms, status, reason, usage, actions
FROM pipeline_stage_run
WHERE task_id = $1`;

function isStage(value: string): value is PipelineStage {
  return (PIPELINE_STAGES as readonly string[]).includes(value);
}

function isStatus(value: string): value is StageRunStatus {
  return value === "running" || value === "completed" || value === "failed";
}

function readTimestamp(value: unknown, label: string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  throw new Error(`invalid pipeline_stage_run ${label}`);
}

function readOptionalTimestamp(value: unknown): string | undefined {
  if (value == null) return undefined;
  return readTimestamp(value, "ended_at");
}

function readOptionalInt(value: unknown): number | undefined {
  if (value == null) return undefined;
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("invalid pipeline_stage_run duration_ms");
  }
  return parsed;
}

function readJson<T>(value: unknown, label: string): T {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(parsed)) throw new Error(`invalid pipeline_stage_run ${label}`);
  return parsed as T;
}

function rowToRecord(row: Record<string, unknown>): StageRunRecord {
  const stage = row.stage;
  const status = row.status;
  if (typeof stage !== "string" || !isStage(stage))
    throw new Error("invalid pipeline_stage_run stage");
  if (typeof status !== "string" || !isStatus(status)) {
    throw new Error("invalid pipeline_stage_run status");
  }
  if (typeof row.task_id !== "string" || typeof row.session_id !== "string") {
    throw new Error("invalid pipeline_stage_run identity");
  }
  const record: StageRunRecord = {
    taskId: row.task_id,
    sessionId: row.session_id,
    stage,
    startedAt: readTimestamp(row.started_at, "started_at"),
    status,
    usage: readJson<StageUsageEntry[]>(row.usage, "usage"),
    actions: readJson<AgentActionEntry[]>(row.actions, "actions"),
  };
  const endedAt = readOptionalTimestamp(row.ended_at);
  const durationMs = readOptionalInt(row.duration_ms);
  if (endedAt) record.endedAt = endedAt;
  if (durationMs !== undefined) record.durationMs = durationMs;
  if (typeof row.reason === "string" && row.reason.length > 0) record.reason = row.reason;
  return record;
}

function toParams(record: StageRunRecord): unknown[] {
  return [
    record.taskId,
    record.sessionId,
    record.stage,
    record.startedAt,
    record.endedAt ?? null,
    record.durationMs ?? null,
    record.status,
    record.reason ?? null,
    JSON.stringify(record.usage),
    JSON.stringify(record.actions),
  ];
}

export function createSqlStageRunStore(db: SqlExecutor): StageRunStore {
  return {
    async get(taskId, sessionId, stage) {
      const result = await db.query(SELECT_STAGE_RUN_SQL, [taskId, sessionId, stage]);
      const row = result.rows[0];
      return row ? rowToRecord(row) : undefined;
    },
    async save(record) {
      await db.query(UPSERT_STAGE_RUN_SQL, toParams(record));
    },
    async listByTask(taskId) {
      const result = await db.query(LIST_STAGE_RUNS_SQL, [taskId]);
      return result.rows.map(rowToRecord);
    },
  };
}

export async function createPgStageRunStore(
  connectionString: string,
): Promise<StageRunStore & { close(): Promise<void> }> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString });
  const db: SqlExecutor = {
    async query(sql, params) {
      const result = await pool.query(sql, params as unknown[] | undefined);
      return { rows: result.rows as Record<string, unknown>[] };
    },
  };
  await db.query(loadPipelineStageRunDdl());
  const store = createSqlStageRunStore(db);
  return {
    get: (taskId, sessionId, stage) => store.get(taskId, sessionId, stage),
    save: (record) => store.save(record),
    listByTask: (taskId) => store.listByTask(taskId),
    close: () => pool.end(),
  };
}
