/**
 * Optio catalog HTTP API (ENG-23).
 * Auth v0 = email/password. Connections store Infisical path refs only — never plaintext secrets.
 * Glass / OpenWebUI UI is out of scope.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ZodError, z } from "zod";
import { createDb, type OptioDb } from "../db/client.js";
import { createDrizzleOptioApiStore } from "./drizzle-store.js";
import { getDummyPasswordHash, hashPassword, verifyPassword } from "./password.js";
import {
  mintSessionToken,
  resolveSessionSecret,
  verifySessionToken,
  type SessionClaims,
} from "./session.js";
import {
  StoreConflictError,
  type ConnectionRow,
  type MembershipRole,
  type MembershipView,
  type OptioApiStore,
  type TenantRow,
  type UserRow,
  type WorkspaceRow,
} from "./store.js";

const MAX_BODY_BYTES = 65_536;

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONNECTION_KINDS = ["github", "linear", "slack", "mcp"] as const;
const MEMBERSHIP_ROLES = ["owner", "admin", "member", "viewer"] as const;

/** Keys that must never appear in connection payloads (plaintext secrets). */
const FORBIDDEN_SECRET_KEYS = new Set([
  "token",
  "accesstoken",
  "access_token",
  "apitoken",
  "api_token",
  "apikey",
  "api_key",
  "secret",
  "password",
  "credential",
  "credentials",
  "privatekey",
  "private_key",
  "clientsecret",
  "client_secret",
  "authorization",
  "bearer",
  "webhooksecret",
  "webhook_secret",
]);

/** Known secret value shapes — block even under innocuous keys. */
const SECRET_VALUE_PATTERNS = [
  /\bghp_[A-Za-z0-9_]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i,
  /\blin_api_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._\-+/=]{20,}\b/i,
];

const SlugSchema = z.string().min(1).max(64).regex(SLUG_RE, "slug must be lowercase kebab-case");
const UuidSchema = z.string().uuid();

const RegisterSchema = z
  .object({
    email: z.string().email().max(320),
    password: z.string().min(8).max(200),
    tenantName: z.string().min(1).max(200),
    tenantSlug: SlugSchema,
    workspaceName: z.string().min(1).max(200).optional(),
    workspaceSlug: SlugSchema.optional(),
    infisicalEnvSlug: z.string().min(1).max(128).optional(),
  })
  .superRefine((body, ctx) => {
    const hasName = body.workspaceName !== undefined;
    const hasSlug = body.workspaceSlug !== undefined;
    if (hasName !== hasSlug) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "workspaceName and workspaceSlug must both be set",
        path: hasName ? ["workspaceSlug"] : ["workspaceName"],
      });
    }
  });

const LoginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
  tenantSlug: SlugSchema,
});

const CreateWorkspaceSchema = z.object({
  name: z.string().min(1).max(200),
  slug: SlugSchema,
  infisicalEnvSlug: z.string().min(1).max(128).optional(),
});

const SwitchMembershipSchema = z.object({
  workspaceId: z.string().uuid(),
});

const ConnectionCreateSchema = z.object({
  kind: z.enum(CONNECTION_KINDS),
  name: z.string().min(1).max(200),
  infisicalSecretPath: z.string().min(1).max(512),
  config: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

const ConnectionPatchSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    infisicalSecretPath: z.string().min(1).max(512).optional(),
    config: z.record(z.unknown()).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "at least one field required" });

export class ApiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(typeof body.message === "string" ? body.message : "api error");
  }
}

export interface OptioApiServerOptions {
  store: OptioApiStore;
  sessionSecret?: string;
  /** When set, GET /health can report db readiness. */
  checkDb?: () => Promise<boolean>;
}

export function resolveOptioApiListen(env: NodeJS.ProcessEnv = process.env): {
  host: string;
  port: number;
} {
  const host = env.OPTIO_NEW_API_HOST?.trim() || "127.0.0.1";
  const parsed = Number(env.OPTIO_NEW_API_PORT ?? "3210");
  const port = Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : 3210;
  return { host, port };
}

export function createOptioApiServer(options: OptioApiServerOptions): Server {
  const secret = options.sessionSecret ?? resolveSessionSecret();
  return createServer((req, res) => {
    void handleOptioApiRequest(req, res, options, secret).catch((error: unknown) => {
      if (error instanceof ApiHttpError) {
        sendJson(res, error.status, error.body);
        return;
      }
      if (error instanceof ZodError) {
        sendJson(res, 400, {
          error: "invalid_request",
          message: "Request validation failed",
          issues: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        });
        return;
      }
      if (error instanceof StoreConflictError) {
        sendJson(res, 409, { error: "conflict", message: error.message });
        return;
      }
      sendJson(res, 500, { error: "internal_error", message: "Unexpected server error" });
    });
  });
}

/** Build a production server backed by Drizzle + Postgres. Caller owns `db.close()`. */
export function createDrizzleOptioApiServer(
  db: OptioDb,
  options?: Omit<OptioApiServerOptions, "store" | "checkDb">,
): Server {
  return createOptioApiServer({
    ...options,
    store: createDrizzleOptioApiStore(db),
    checkDb: async () => {
      try {
        await db.pool.query("select 1");
        return true;
      } catch {
        return false;
      }
    },
  });
}

export async function startOptioApiFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options?: { db?: OptioDb },
): Promise<{ server: Server; db: OptioDb; host: string; port: number; ownsDb: boolean }> {
  const ownsDb = !options?.db;
  let db = options?.db;
  if (!db) {
    const databaseUrl = env.OPTIO_NEW_DATABASE_URL?.trim();
    if (!databaseUrl) {
      throw new Error("OPTIO_NEW_DATABASE_URL is required for the catalog API");
    }
    db = createDb(databaseUrl);
  }
  const { host, port } = resolveOptioApiListen(env);
  const server = createDrizzleOptioApiServer(db, {
    sessionSecret: resolveSessionSecret(env),
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  return { server, db, host, port, ownsDb };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      req.destroy();
      throw new ApiHttpError(413, {
        error: "payload_too_large",
        message: "Request body exceeds 64 KiB",
      });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function parsePathUuid(raw: string, label: string): string {
  const parsed = UuidSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiHttpError(404, { error: "not_found", message: `${label} not found` });
  }
  return parsed.data;
}

function canCreateWorkspace(memberships: MembershipView[]): boolean {
  // Bootstrap (no memberships yet) or owner/admin of any workspace in the tenant.
  return (
    memberships.length === 0 || memberships.some((m) => m.role === "owner" || m.role === "admin")
  );
}

function resolveActiveWorkspaceId(memberships: MembershipView[]): string | undefined {
  // Single membership → auto-select. Multiple → require explicit switch (no unordered pick).
  return memberships.length === 1 ? memberships[0]!.workspaceId : undefined;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readRawBody(req);
  const text = raw.toString("utf8");
  if (text.trim() === "") {
    throw new ApiHttpError(400, {
      error: "invalid_json",
      message: "Request body must be JSON",
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiHttpError(400, {
      error: "invalid_json",
      message: "Request body must be JSON",
    });
  }
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header || typeof header !== "string") return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

function requireAuth(req: IncomingMessage, secret: string): SessionClaims {
  const token = bearerToken(req);
  if (!token) {
    throw new ApiHttpError(401, { error: "unauthorized", message: "Missing bearer token" });
  }
  const claims = verifySessionToken(token, secret);
  if (!claims) {
    throw new ApiHttpError(401, { error: "unauthorized", message: "Invalid or expired token" });
  }
  return claims;
}

function publicUser(user: UserRow): { id: string; tenantId: string; email: string } {
  return { id: user.id, tenantId: user.tenantId, email: user.email };
}

function publicTenant(tenant: TenantRow): { id: string; name: string; slug: string } {
  return { id: tenant.id, name: tenant.name, slug: tenant.slug };
}

function publicWorkspace(workspace: WorkspaceRow) {
  return {
    id: workspace.id,
    tenantId: workspace.tenantId,
    name: workspace.name,
    slug: workspace.slug,
    infisicalEnvSlug: workspace.infisicalEnvSlug,
    defaultCodingBackend: workspace.defaultCodingBackend,
  };
}

function publicMembership(view: MembershipView) {
  return {
    userId: view.userId,
    workspaceId: view.workspaceId,
    role: view.role,
    workspace: publicWorkspace(view.workspace),
  };
}

function publicConnection(row: ConnectionRow) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    kind: row.kind,
    name: row.name,
    infisicalSecretPath: row.infisicalSecretPath,
    config: row.config,
    enabled: row.enabled,
  };
}

function looksLikeSecretValue(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/** Reject plaintext secret keys/values anywhere in a JSON object tree. */
export function assertNoPlaintextSecrets(value: unknown, path = "body"): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    if (looksLikeSecretValue(value)) {
      throw new ApiHttpError(400, {
        error: "plaintext_secret_rejected",
        message: `Value at '${path}' looks like a plaintext secret — store it in Infisical and pass infisicalSecretPath only`,
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPlaintextSecrets(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9_]/g, "");
    if (FORBIDDEN_SECRET_KEYS.has(normalized) || FORBIDDEN_SECRET_KEYS.has(key.toLowerCase())) {
      throw new ApiHttpError(400, {
        error: "plaintext_secret_rejected",
        message: `Field '${path}.${key}' is not allowed — store secrets in Infisical and pass infisicalSecretPath only`,
      });
    }
    assertNoPlaintextSecrets(child, `${path}.${key}`);
  }
}

function canWriteConnections(role: MembershipRole): boolean {
  return role === "owner" || role === "admin";
}

async function requireWorkspaceAccess(
  store: OptioApiStore,
  claims: SessionClaims,
  workspaceId: string,
): Promise<{ membership: { role: MembershipRole }; workspace: WorkspaceRow }> {
  const workspace = await store.findWorkspaceById(workspaceId);
  if (!workspace || workspace.tenantId !== claims.tenantId) {
    throw new ApiHttpError(404, { error: "not_found", message: "Workspace not found" });
  }
  const membership = await store.findMembership(claims.userId, workspaceId);
  if (!membership) {
    throw new ApiHttpError(403, {
      error: "forbidden",
      message: "Not a member of this workspace",
    });
  }
  return { membership, workspace };
}

async function handleOptioApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: OptioApiServerOptions,
  secret: string,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  const method = req.method ?? "GET";
  const { store } = options;

  if (path === "/health" && (method === "GET" || method === "HEAD")) {
    const dbOk = options.checkDb ? await options.checkDb() : true;
    const body = { ok: dbOk, service: "optio-api" as const, db: dbOk ? "up" : "down" };
    if (method === "HEAD") {
      res.writeHead(dbOk ? 200 : 503, { "content-type": "application/json; charset=utf-8" });
      res.end();
      return;
    }
    sendJson(res, dbOk ? 200 : 503, body);
    return;
  }

  if (path === "/auth/register" && method === "POST") {
    const body = RegisterSchema.parse(await readJsonBody(req));
    const passwordHash = await hashPassword(body.password);
    const bootstrap = await store.registerBootstrap({
      tenantName: body.tenantName,
      tenantSlug: body.tenantSlug,
      email: body.email,
      passwordHash,
      ...(body.workspaceName && body.workspaceSlug
        ? {
            workspace: {
              name: body.workspaceName,
              slug: body.workspaceSlug,
              ...(body.infisicalEnvSlug ? { infisicalEnvSlug: body.infisicalEnvSlug } : {}),
            },
          }
        : {}),
    });
    const memberships = await store.listMemberships(bootstrap.user.id);
    const activeWorkspaceId = resolveActiveWorkspaceId(memberships);
    const token = mintSessionToken(
      {
        userId: bootstrap.user.id,
        tenantId: bootstrap.tenant.id,
        ...(activeWorkspaceId ? { workspaceId: activeWorkspaceId } : {}),
      },
      secret,
    );
    sendJson(res, 201, {
      token,
      user: publicUser(bootstrap.user),
      tenant: publicTenant(bootstrap.tenant),
      workspace: bootstrap.workspace ? publicWorkspace(bootstrap.workspace) : null,
      memberships: memberships.map(publicMembership),
    });
    return;
  }

  if (path === "/auth/login" && method === "POST") {
    const body = LoginSchema.parse(await readJsonBody(req));
    const tenant = await store.findTenantBySlug(body.tenantSlug);
    const user = tenant ? await store.findUserByTenantEmail(tenant.id, body.email) : undefined;
    // Always verify against a real scrypt hash to reduce timing oracles.
    const passwordOk = await verifyPassword(
      body.password,
      user?.passwordHash ?? (await getDummyPasswordHash()),
    );
    if (!tenant || !user || !passwordOk) {
      throw new ApiHttpError(401, { error: "unauthorized", message: "Invalid credentials" });
    }
    const memberships = await store.listMemberships(user.id);
    const activeWorkspaceId = resolveActiveWorkspaceId(memberships);
    const token = mintSessionToken(
      {
        userId: user.id,
        tenantId: tenant.id,
        ...(activeWorkspaceId ? { workspaceId: activeWorkspaceId } : {}),
      },
      secret,
    );
    sendJson(res, 200, {
      token,
      user: publicUser(user),
      tenant: publicTenant(tenant),
      activeWorkspaceId: activeWorkspaceId ?? null,
      memberships: memberships.map(publicMembership),
    });
    return;
  }

  if (path === "/auth/me" && method === "GET") {
    const claims = requireAuth(req, secret);
    const user = await store.findUserById(claims.userId);
    const tenant = await store.findTenantById(claims.tenantId);
    if (!user || !tenant) {
      throw new ApiHttpError(401, { error: "unauthorized", message: "Session subject missing" });
    }
    const memberships = await store.listMemberships(user.id);
    sendJson(res, 200, {
      user: publicUser(user),
      tenant: publicTenant(tenant),
      activeWorkspaceId: claims.workspaceId ?? null,
      memberships: memberships.map(publicMembership),
    });
    return;
  }

  if (path === "/memberships" && method === "GET") {
    const claims = requireAuth(req, secret);
    const memberships = await store.listMemberships(claims.userId);
    sendJson(res, 200, {
      activeWorkspaceId: claims.workspaceId ?? null,
      memberships: memberships.map(publicMembership),
    });
    return;
  }

  if (path === "/memberships/switch" && method === "POST") {
    const claims = requireAuth(req, secret);
    const body = SwitchMembershipSchema.parse(await readJsonBody(req));
    await requireWorkspaceAccess(store, claims, body.workspaceId);
    const token = mintSessionToken(
      {
        userId: claims.userId,
        tenantId: claims.tenantId,
        workspaceId: body.workspaceId,
      },
      secret,
    );
    sendJson(res, 200, {
      token,
      activeWorkspaceId: body.workspaceId,
    });
    return;
  }

  if (path === "/workspaces" && method === "POST") {
    const claims = requireAuth(req, secret);
    const existingMemberships = await store.listMemberships(claims.userId);
    if (!canCreateWorkspace(existingMemberships)) {
      throw new ApiHttpError(403, {
        error: "forbidden",
        message: "Owner or admin role required to create a workspace",
      });
    }
    const body = CreateWorkspaceSchema.parse(await readJsonBody(req));
    const workspace = await store.createWorkspace({
      tenantId: claims.tenantId,
      name: body.name,
      slug: body.slug,
      infisicalEnvSlug: body.infisicalEnvSlug ?? body.slug,
    });
    await store.upsertMembership({
      userId: claims.userId,
      workspaceId: workspace.id,
      role: "owner",
    });
    const token = mintSessionToken(
      {
        userId: claims.userId,
        tenantId: claims.tenantId,
        workspaceId: workspace.id,
      },
      secret,
    );
    sendJson(res, 201, {
      token,
      workspace: publicWorkspace(workspace),
    });
    return;
  }

  const connectionsMatch = /^\/workspaces\/([^/]+)\/connections(?:\/([^/]+))?$/.exec(path);
  if (connectionsMatch) {
    const workspaceId = parsePathUuid(connectionsMatch[1]!, "Workspace");
    const connectionId = connectionsMatch[2]
      ? parsePathUuid(connectionsMatch[2], "Connection")
      : undefined;
    const claims = requireAuth(req, secret);
    const { membership } = await requireWorkspaceAccess(store, claims, workspaceId);

    if (!connectionId && method === "GET") {
      const rows = await store.listConnections(workspaceId);
      sendJson(res, 200, { connections: rows.map(publicConnection) });
      return;
    }

    if (!connectionId && method === "POST") {
      if (!canWriteConnections(membership.role)) {
        throw new ApiHttpError(403, {
          error: "forbidden",
          message: "Owner or admin role required to manage connections",
        });
      }
      const raw = await readJsonBody(req);
      assertNoPlaintextSecrets(raw);
      const body = ConnectionCreateSchema.parse(raw);
      assertNoPlaintextSecrets(body.config ?? {});
      const row = await store.createConnection({
        workspaceId,
        kind: body.kind,
        name: body.name,
        infisicalSecretPath: body.infisicalSecretPath,
        config: body.config,
        enabled: body.enabled,
      });
      sendJson(res, 201, { connection: publicConnection(row) });
      return;
    }

    if (connectionId && method === "GET") {
      const row = await store.findConnection(workspaceId, connectionId);
      if (!row) {
        throw new ApiHttpError(404, { error: "not_found", message: "Connection not found" });
      }
      sendJson(res, 200, { connection: publicConnection(row) });
      return;
    }

    if (connectionId && method === "PATCH") {
      if (!canWriteConnections(membership.role)) {
        throw new ApiHttpError(403, {
          error: "forbidden",
          message: "Owner or admin role required to manage connections",
        });
      }
      const raw = await readJsonBody(req);
      assertNoPlaintextSecrets(raw);
      const body = ConnectionPatchSchema.parse(raw);
      if (body.config) assertNoPlaintextSecrets(body.config);
      const row = await store.updateConnection(workspaceId, connectionId, body);
      if (!row) {
        throw new ApiHttpError(404, { error: "not_found", message: "Connection not found" });
      }
      sendJson(res, 200, { connection: publicConnection(row) });
      return;
    }

    if (connectionId && method === "DELETE") {
      if (!canWriteConnections(membership.role)) {
        throw new ApiHttpError(403, {
          error: "forbidden",
          message: "Owner or admin role required to manage connections",
        });
      }
      const deleted = await store.deleteConnection(workspaceId, connectionId);
      if (!deleted) {
        throw new ApiHttpError(404, { error: "not_found", message: "Connection not found" });
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 405, { error: "method_not_allowed" });
    return;
  }

  const agentsMatch = /^\/workspaces\/([^/]+)\/agents$/.exec(path);
  if (agentsMatch && method === "GET") {
    const workspaceId = parsePathUuid(agentsMatch[1]!, "Workspace");
    const claims = requireAuth(req, secret);
    await requireWorkspaceAccess(store, claims, workspaceId);
    const rows = await store.listAgents(workspaceId);
    sendJson(res, 200, { agents: rows });
    return;
  }

  const skillsMatch = /^\/workspaces\/([^/]+)\/skills$/.exec(path);
  if (skillsMatch && method === "GET") {
    const workspaceId = parsePathUuid(skillsMatch[1]!, "Workspace");
    const claims = requireAuth(req, secret);
    await requireWorkspaceAccess(store, claims, workspaceId);
    const rows = await store.listSkills(workspaceId);
    sendJson(res, 200, { skills: rows });
    return;
  }

  if (
    method !== "GET" &&
    method !== "HEAD" &&
    method !== "POST" &&
    method !== "PATCH" &&
    method !== "DELETE"
  ) {
    sendJson(res, 405, { error: "method_not_allowed" });
    return;
  }

  sendJson(res, 404, {
    error: "not_found",
    message: "Unknown route",
    routes: [
      "GET /health",
      "POST /auth/register",
      "POST /auth/login",
      "GET /auth/me",
      "GET /memberships",
      "POST /memberships/switch",
      "POST /workspaces",
      "GET|POST /workspaces/:id/connections",
      "GET|PATCH|DELETE /workspaces/:id/connections/:connectionId",
      "GET /workspaces/:id/agents",
      "GET /workspaces/:id/skills",
    ],
  });
}

export const OPTIO_API_MEMBERSHIP_ROLES = MEMBERSHIP_ROLES;
export const OPTIO_API_CONNECTION_KINDS = CONNECTION_KINDS;
