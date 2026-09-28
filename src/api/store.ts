/**
 * Catalog API persistence seam (ENG-23).
 * Memory store for unit tests; Drizzle store for Postgres.
 */

export type ConnectionKind = "github" | "linear" | "slack" | "mcp";
export type MembershipRole = "owner" | "admin" | "member" | "viewer";
export type CodingBackend = "cursor-cli" | "flue" | "codex";

export interface TenantRow {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserRow {
  id: string;
  tenantId: string;
  email: string;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkspaceRow {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  infisicalEnvSlug: string | null;
  defaultCodingBackend: CodingBackend;
  createdAt: Date;
  updatedAt: Date;
}

export interface MembershipRow {
  userId: string;
  workspaceId: string;
  role: MembershipRole;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConnectionRow {
  id: string;
  workspaceId: string;
  kind: ConnectionKind;
  name: string;
  infisicalSecretPath: string;
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentCatalogRow {
  id: string;
  workspaceId: string;
  name: string;
  kind: string;
  model: string | null;
  enabled: boolean;
}

export interface SkillCatalogRow {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  description: string | null;
  enabled: boolean;
}

export interface MembershipView extends MembershipRow {
  workspace: WorkspaceRow;
}

export interface OptioApiStore {
  createTenant(input: { name: string; slug: string }): Promise<TenantRow>;
  findTenantBySlug(slug: string): Promise<TenantRow | undefined>;
  findTenantById(id: string): Promise<TenantRow | undefined>;

  createUser(input: { tenantId: string; email: string; passwordHash: string }): Promise<UserRow>;
  findUserByTenantEmail(tenantId: string, email: string): Promise<UserRow | undefined>;
  findUserById(id: string): Promise<UserRow | undefined>;

  createWorkspace(input: {
    tenantId: string;
    name: string;
    slug: string;
    infisicalEnvSlug?: string | null;
    defaultCodingBackend?: CodingBackend;
  }): Promise<WorkspaceRow>;
  findWorkspaceById(id: string): Promise<WorkspaceRow | undefined>;

  upsertMembership(input: {
    userId: string;
    workspaceId: string;
    role: MembershipRole;
  }): Promise<MembershipRow>;
  listMemberships(userId: string): Promise<MembershipView[]>;
  findMembership(userId: string, workspaceId: string): Promise<MembershipRow | undefined>;

  listConnections(workspaceId: string): Promise<ConnectionRow[]>;
  findConnection(workspaceId: string, connectionId: string): Promise<ConnectionRow | undefined>;
  createConnection(input: {
    workspaceId: string;
    kind: ConnectionKind;
    name: string;
    infisicalSecretPath: string;
    config?: Record<string, unknown>;
    enabled?: boolean;
  }): Promise<ConnectionRow>;
  updateConnection(
    workspaceId: string,
    connectionId: string,
    patch: {
      name?: string;
      infisicalSecretPath?: string;
      config?: Record<string, unknown>;
      enabled?: boolean;
    },
  ): Promise<ConnectionRow | undefined>;
  deleteConnection(workspaceId: string, connectionId: string): Promise<boolean>;

  listAgents(workspaceId: string): Promise<AgentCatalogRow[]>;
  listSkills(workspaceId: string): Promise<SkillCatalogRow[]>;
}

export class StoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreConflictError";
  }
}

export class StoreNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreNotFoundError";
  }
}
