import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { resolveDatabaseUrl } from "./database-url.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Resolve `drizzle/` from dist (`dist/src/db`), source (`src/db`), or cwd. */
export function resolveMigrationsFolder(fromDir: string = here): string {
  const candidates = [
    join(fromDir, "../../..", "drizzle"),
    join(fromDir, "../..", "drizzle"),
    join(process.cwd(), "drizzle"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return join(process.cwd(), "drizzle");
}

/**
 * Apply forward Drizzle migrations (optio/flue). Idempotent via drizzle journal.
 * Call before serving traffic when OPTIO_NEW_DATABASE_URL is set.
 */
export async function runDrizzleMigrations(
  connectionString: string = resolveDatabaseUrl(),
  migrationsFolder: string = resolveMigrationsFolder(),
): Promise<void> {
  const pool = new pg.Pool({ connectionString });
  try {
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder });
  } finally {
    await pool.end();
  }
}

/** CLI: `node dist/src/db/migrate-cli.js` */
async function main(): Promise<void> {
  const url = resolveDatabaseUrl();
  const folder = resolveMigrationsFolder();
  console.info(`[db] migrating from ${folder}`);
  await runDrizzleMigrations(url, folder);
  console.info("[db] migrate ok");
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("migrate-cli.js") || entry.endsWith("migrate-cli.ts")) {
  main().catch((err: unknown) => {
    console.error("[db] migrate failed", err);
    process.exitCode = 1;
  });
}
