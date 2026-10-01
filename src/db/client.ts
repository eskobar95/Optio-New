import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type pg from "pg";
import type { TenantContext } from "../config/tenant.js";
import * as schema from "./schema/index.js";
import { withTenantClient } from "./with-tenant.js";

export { DEFAULT_LOCAL_DATABASE_URL, resolveDatabaseUrl } from "./database-url.js";

/** Drizzle bound to one tenant transaction; already inside BEGIN, so do not call `.transaction`. */
export type TenantDrizzle = NodePgDatabase<typeof schema>;

export type OptioDb = ReturnType<typeof createDb>;

/**
 * Drizzle access for one tenant on a pool the caller owns. Every `run` is one `withTenant`
 * transaction; there is no handle to the raw pool.
 */
export function createDb(pool: pg.Pool, tenant: TenantContext) {
  const run = <T>(fn: (db: TenantDrizzle) => Promise<T>): Promise<T> =>
    withTenantClient(pool, tenant, (client) => fn(drizzle(client, { schema })));
  return {
    run,
    async ping(): Promise<boolean> {
      try {
        await run((db) => db.execute(sql`select 1`));
        return true;
      } catch {
        return false;
      }
    },
  };
}
