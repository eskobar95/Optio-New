import { z } from "zod";
import { SessionGateError, type SessionOverflow } from "./types.js";

export const SessionConcurrencyConfigSchema = z.object({
  cursor: z.number().int().nonnegative(),
  codex: z.number().int().nonnegative(),
  overflow: z.enum(["queue", "reject"]),
  worktreeRoot: z.string().min(1),
});

export type SessionConcurrencyConfig = z.infer<typeof SessionConcurrencyConfigSchema>;

/** Conservative VPS defaults until box-size caps are chosen (SPEC open question). */
export const DEFAULT_SESSION_CONCURRENCY: SessionConcurrencyConfig = {
  cursor: 1,
  codex: 1,
  overflow: "queue",
  worktreeRoot: "/var/lib/optio-new/worktrees",
};

const ENV_CURSOR = "OPTIO_NEW_CURSOR_MAX_CONCURRENCY";
const ENV_CODEX = "OPTIO_NEW_CODEX_MAX_CONCURRENCY";
const ENV_OVERFLOW = "OPTIO_NEW_SESSION_OVERFLOW";
const ENV_ROOT = "OPTIO_NEW_WORKTREE_ROOT";

function readNonNegativeInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) {
    throw new SessionGateError("invalid_request", `${key} must be a non-negative integer`);
  }
  return Number(raw.trim());
}

function readOverflow(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: SessionOverflow,
): SessionOverflow {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = raw.trim();
  if (value === "queue" || value === "reject") return value;
  throw new SessionGateError("invalid_request", `${key} must be queue or reject`);
}

/** Read per-provider caps. Missing vars use defaults. Invalid values fail closed. */
export function loadSessionConcurrencyConfig(
  env: NodeJS.ProcessEnv = process.env,
): SessionConcurrencyConfig {
  return SessionConcurrencyConfigSchema.parse({
    cursor: readNonNegativeInt(env, ENV_CURSOR, DEFAULT_SESSION_CONCURRENCY.cursor),
    codex: readNonNegativeInt(env, ENV_CODEX, DEFAULT_SESSION_CONCURRENCY.codex),
    overflow: readOverflow(env, ENV_OVERFLOW, DEFAULT_SESSION_CONCURRENCY.overflow),
    worktreeRoot: (() => {
      const raw = env[ENV_ROOT];
      if (raw === undefined || raw.trim() === "") return DEFAULT_SESSION_CONCURRENCY.worktreeRoot;
      return raw.trim();
    })(),
  });
}
