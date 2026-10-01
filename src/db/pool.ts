import pg from "pg";

let shared: { url: string; pool: pg.Pool } | undefined;

/** The one `pg.Pool` of this process. A second URL is a bug, not a second pool. */
export function getSharedPool(connectionString: string): pg.Pool {
  if (shared) {
    if (shared.url !== connectionString) {
      throw new Error("shared pool already open for a different connection string");
    }
    return shared.pool;
  }
  const pool = new pg.Pool({ connectionString });
  shared = { url: connectionString, pool };
  return pool;
}

export async function closeSharedPool(): Promise<void> {
  const current = shared;
  shared = undefined;
  await current?.pool.end();
}
