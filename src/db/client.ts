import { drizzle } from "drizzle-orm/node-postgres";
import { closeSharedPool, getSharedPool } from "./pool.js";
import * as schema from "./schema/index.js";
import { resolveDatabaseUrl } from "./database-url.js";

export { DEFAULT_LOCAL_DATABASE_URL, resolveDatabaseUrl } from "./database-url.js";

export type OptioDb = ReturnType<typeof createDb>;

/** Thin Drizzle wrapper over the process-wide shared `pg.Pool`. Does not apply legacy `state/migrations` DDL. */
export function createDb(connectionString: string = resolveDatabaseUrl()) {
  const pool = getSharedPool(connectionString);
  const db = drizzle(pool, { schema });
  return Object.assign(db, {
    pool,
    async close(): Promise<void> {
      await closeSharedPool();
    },
  });
}
