/** Shared Postgres URL helpers — keep Compose defaults in sync (`changeme`). */
export const DEFAULT_LOCAL_DATABASE_URL = "postgresql://optio:changeme@127.0.0.1:5432/optio_new";

export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPTIO_NEW_DATABASE_URL?.trim() || DEFAULT_LOCAL_DATABASE_URL;
}
