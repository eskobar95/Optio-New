import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.js";
import { resolveDatabaseUrl } from "./database-url.js";

export { DEFAULT_LOCAL_DATABASE_URL, resolveDatabaseUrl } from "./database-url.js";

export type OptioDb = ReturnType<typeof createDb>;

/** Thin Drizzle wrapper over `pg.Pool`. Does not apply legacy `state/migrations` DDL. */
export function createDb(connectionString: string = resolveDatabaseUrl()) {
  const pool = new pg.Pool({ connectionString });
  const db = drizzle(pool, { schema });
  return Object.assign(db, {
    pool,
    async close(): Promise<void> {
      await pool.end();
    },
  });
}
