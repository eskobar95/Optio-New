import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.js";

const DEFAULT_LOCAL_URL = "postgresql://optio:optio@127.0.0.1:5432/optio_new";

export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPTIO_NEW_DATABASE_URL?.trim() || DEFAULT_LOCAL_URL;
}

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
