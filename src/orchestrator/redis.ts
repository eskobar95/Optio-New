/**
 * Redis connection settings from OPTIO_NEW_REDIS_URL.
 * BullMQ workers require maxRetriesPerRequest: null.
 */
export interface RedisConnectionOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  maxRetriesPerRequest: null;
  tls?: Record<string, never>;
}

export function redisConnectionOptions(redisUrl: string): RedisConnectionOptions {
  let url: URL;
  try {
    url = new URL(redisUrl);
  } catch {
    throw new Error(`Invalid OPTIO_NEW_REDIS_URL: ${redisUrl}`);
  }
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error(`OPTIO_NEW_REDIS_URL must use redis: or rediss:, got ${url.protocol}`);
  }

  const port = url.port ? Number(url.port) : 6379;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid Redis port in OPTIO_NEW_REDIS_URL: ${url.port}`);
  }

  const dbRaw = url.pathname.replace(/^\//, "");
  const options: RedisConnectionOptions = {
    host: url.hostname,
    port,
    maxRetriesPerRequest: null,
  };
  if (url.username) options.username = decodeURIComponent(url.username);
  if (url.password) options.password = decodeURIComponent(url.password);
  if (dbRaw) {
    const db = Number(dbRaw);
    if (!Number.isInteger(db) || db < 0) {
      throw new Error(`Invalid Redis database index in OPTIO_NEW_REDIS_URL: ${dbRaw}`);
    }
    options.db = db;
  }
  if (url.protocol === "rediss:") options.tls = {};
  return options;
}

export function readOrchestratorPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 3100;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ORCHESTRATOR_PORT: ${raw}`);
  }
  return port;
}
