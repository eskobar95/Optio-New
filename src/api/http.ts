/**
 * Optio catalog HTTP API (ENG-23).
 * Auth v0 = email/password. Connections store Infisical path refs only — never plaintext secrets.
 * Glass / OpenWebUI UI is out of scope.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ZodError, z } from "zod";
import { createDb, type OptioDb } from "../db/client.js";
import { createDrizzleOptioApiStore } from "./drizzle-store.js";
import { hashPassword, verifyPassword } from "./password.js";
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

const SlugSchema = z.string().min(1).max(64).regex(SLUG_RE, "slug must be lowercase kebab-case");

const RegisterSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8).max(200),
  tenantName: z.string().min(1).max(200),
  tenantSlug: SlugSchema,
  workspaceName: z.string().min(1).max(200).optional(),
  workspaceSlug: SlugSchema.optional(),
  infisicalEnvSlug: z.string().min(1).max(128).optional(),
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
): Promise<{ server: Server; db: OptioDb; host: string; port: number }> {
  const databaseUrl = env.OPTIO_NEW_DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("OPTIO_NEW_DATABASE_URL is required for the catalog API");
  }
  const db = createDb(databaseUrl);
  const { host, port } = resolveOptioApiListen(env);
  const server = createDrizzleOptioApiServer(db, {
    sessionSecret: resolveSessionSecret(env),
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  return { server, db, host, port };
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
      throw new ApiHttpError(413, {
        error: "payload_too_large",
        message: "Request body exceeds 64 KiB",
      });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
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

/** Reject plaintext secret keys anywhere in a JSON object tree. */
export function assertNoPlaintextSecrets(value: unknown, path = "body"): void {
  if (value === null || value === undefined) return;
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
    const tenant = await store.createTenant({ name: body.tenantName, slug: body.tenantSlug });
    const passwordHash = await hashPassword(body.password);
    const user = await store.createUser({
      tenantId: tenant.id,
      email: body.email,
      passwordHash,
    });
    let workspace: WorkspaceRow | undefined;
    if (body.workspaceName && body.workspaceSlug) {
      workspace = await store.createWorkspace({
        tenantId: tenant.id,
        name: body.workspaceName,
        slug: body.workspaceSlug,
        infisicalEnvSlug: body.infisicalEnvSlug ?? body.workspaceSlug,
      });
      await store.upsertMembership({
        userId: user.id,
        workspaceId: workspace.id,
        role: "owner",
      });
    } else if (body.workspaceName || body.workspaceSlug) {
      throw new ApiHttpError(400, {
        error: "invalid_request",
        message: "workspaceName and workspaceSlug must both be set",
      });
    }
    const memberships = await store.listMemberships(user.id);
    const token = mintSessionToken(
      {
        userId: user.id,
        tenantId: tenant.id,
        ...(workspace ? { workspaceId: workspace.id } : {}),
      },
      secret,
    );
    sendJson(res, 201, {
      token,
      user: publicUser(user),
      tenant: publicTenant(tenant),
      workspace: workspace ? publicWorkspace(workspace) : null,
      memberships: memberships.map(publicMembership),
    });
    return;
  }

  if (path === "/auth/login" && method === "POST") {
    const body = LoginSchema.parse(await readJsonBody(req));
    const tenant = await store.findTenantBySlug(body.tenantSlug);
    if (!tenant) {
      throw new ApiHttpError(401, { error: "unauthorized", message: "Invalid credentials" });
    }
    const user = await store.findUserByTenantEmail(tenant.id, body.email);
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      throw new ApiHttpError(401, { error: "unauthorized", message: "Invalid credentials" });
    }
    const memberships = await store.listMemberships(user.id);
    const activeWorkspaceId = memberships[0]?.workspaceId;
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
    const workspaceId = connectionsMatch[1]!;
    const connectionId = connectionsMatch[2];
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
    const workspaceId = agentsMatch[1]!;
    const claims = requireAuth(req, secret);
    await requireWorkspaceAccess(store, claims, workspaceId);
    const rows = await store.listAgents(workspaceId);
    sendJson(res, 200, { agents: rows });
    return;
  }

  const skillsMatch = /^\/workspaces\/([^/]+)\/skills$/.exec(path);
  if (skillsMatch && method === "GET") {
    const workspaceId = skillsMatch[1]!;
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
