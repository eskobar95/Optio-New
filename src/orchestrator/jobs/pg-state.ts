/**
 * Step cursor and session artifacts on the shared pool, run as one tenant.
 */
import type pg from "pg";
import type { TenantContext } from "../../config/tenant.js";
import { tenantExecutor } from "../../db/with-tenant.js";
import { createSqlSessionArtifactStore, loadSessionArtifactsDdl } from "../artifacts/store.js";
import type { SessionArtifactStore } from "../artifacts/store.js";
import {
  createSqlStepCursorStore,
  loadPipelineStepCursorDdl,
  type StepCursorStore,
} from "./cursor.js";

export interface OrchestratorDatabase {
  cursors: StepCursorStore;
  artifacts: SessionArtifactStore;
}

export async function openOrchestratorDatabase(
  pool: pg.Pool,
  tenant: TenantContext,
): Promise<OrchestratorDatabase> {
  const db = tenantExecutor(pool, tenant);
  await db.query(loadPipelineStepCursorDdl());
  await db.query(loadSessionArtifactsDdl());
  return {
    cursors: createSqlStepCursorStore(db),
    artifacts: createSqlSessionArtifactStore(db),
  };
}
