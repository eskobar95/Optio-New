/**
 * One Postgres pool for the orchestrator process: step cursor and session artifacts.
 */
import { createSqlSessionArtifactStore, loadSessionArtifactsDdl } from "../artifacts/store.js";
import type { SessionArtifactStore } from "../artifacts/store.js";
import {
  createSqlStepCursorStore,
  loadPipelineStepCursorDdl,
  type SqlExecutor,
  type StepCursorStore,
} from "./cursor.js";

export interface OrchestratorDatabase {
  cursors: StepCursorStore;
  artifacts: SessionArtifactStore;
  close(): Promise<void>;
}

export async function openOrchestratorDatabase(
  connectionString: string,
): Promise<OrchestratorDatabase> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString });
  const db: SqlExecutor = {
    async query(sql, params) {
      const result = await pool.query(sql, params as unknown[] | undefined);
      return { rows: result.rows as Record<string, unknown>[] };
    },
  };
  await db.query(loadPipelineStepCursorDdl());
  await db.query(loadSessionArtifactsDdl());
  return {
    cursors: createSqlStepCursorStore(db),
    artifacts: createSqlSessionArtifactStore(db),
    close: () => pool.end(),
  };
}
