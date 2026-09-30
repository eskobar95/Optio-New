import type pg from "pg";
import type { TenantContext } from "../config/tenant.js";
import type { SqlExecutor } from "./executor.js";

/** Runs `fn` in one transaction whose `app.tenant_id` (and `app.workspace_id`) are transaction-local. */
export async function withTenant<T>(
  pool: pg.Pool,
  ctx: TenantContext,
  fn: (db: SqlExecutor) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // set_config(..., true) is SET LOCAL with bind parameters.
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [ctx.tenantId]);
    if (ctx.workspaceId) {
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [ctx.workspaceId]);
    }
    const result = await fn({
      async query(sql, params) {
        const res = await client.query(sql, params as unknown[] | undefined);
        return { rows: res.rows as Record<string, unknown>[] };
      },
    });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // the original error is the useful one
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Executor for the raw-SQL stores: each query runs in its own `withTenant` transaction. */
export function tenantExecutor(pool: pg.Pool, ctx: TenantContext): SqlExecutor {
  return {
    query: (sql, params) => withTenant(pool, ctx, (db) => db.query(sql, params)),
  };
}
