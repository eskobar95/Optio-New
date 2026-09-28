/**
 * Signed bearer sessions for the Optio catalog API (ENG-23).
 * No session table in schema — HMAC payload carries identity + optional workspace.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface SessionClaims {
  userId: string;
  tenantId: string;
  /** Active workspace for connection/catalog routes; may be unset until switch. */
  workspaceId?: string;
  exp: number;
}

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 7;

export function resolveSessionSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.OPTIO_NEW_API_SESSION_SECRET?.trim();
  if (secret && secret.length >= 16) return secret;
  if ((env.OPTIO_NEW_ENV ?? env.NODE_ENV) === "production") {
    throw new Error("OPTIO_NEW_API_SESSION_SECRET is required in production (min 16 chars)");
  }
  return "dev-only-optio-api-session-secret";
}

export function mintSessionToken(
  claims: Omit<SessionClaims, "exp"> & { exp?: number },
  secret: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): string {
  const payload: SessionClaims = {
    userId: claims.userId,
    tenantId: claims.tenantId,
    ...(claims.workspaceId ? { workspaceId: claims.workspaceId } : {}),
    exp: claims.exp ?? Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifySessionToken(token: string, secret: string): SessionClaims | undefined {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!body || !sig) return undefined;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.userId !== "string" || typeof obj.tenantId !== "string") return undefined;
  if (typeof obj.exp !== "number" || !Number.isFinite(obj.exp)) return undefined;
  if (obj.exp < Math.floor(Date.now() / 1000)) return undefined;
  const workspaceId = typeof obj.workspaceId === "string" ? obj.workspaceId : undefined;
  return {
    userId: obj.userId,
    tenantId: obj.tenantId,
    ...(workspaceId ? { workspaceId } : {}),
    exp: obj.exp,
  };
}
