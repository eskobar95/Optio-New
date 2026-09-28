/**
 * In-memory OptioApiStore for unit tests (ENG-23).
 */
import { randomUUID } from "node:crypto";
import {
  StoreConflictError,
  type AgentCatalogRow,
  type CodingBackend,
  type ConnectionKind,
  type ConnectionRow,
  type MembershipRole,
  type MembershipRow,
  type MembershipView,
  type OptioApiStore,
  type RegisterBootstrapInput,
  type RegisterBootstrapResult,
  type SkillCatalogRow,
  type TenantRow,
  type UserRow,
  type WorkspaceRow,
} from "./store.js";

function now(): Date {
  return new Date();
}

export class MemoryOptioApiStore implements OptioApiStore {
  readonly tenants = new Map<string, TenantRow>();
  readonly users = new Map<string, UserRow>();
  readonly workspaces = new Map<string, WorkspaceRow>();
  readonly memberships = new Map<string, MembershipRow>();
  readonly connections = new Map<string, ConnectionRow>();
  readonly agents = new Map<string, AgentCatalogRow>();
  readonly skills = new Map<string, SkillCatalogRow>();

  private membershipKey(userId: string, workspaceId: string): string {
    return `${userId}:${workspaceId}`;
  }

  async registerBootstrap(input: RegisterBootstrapInput): Promise<RegisterBootstrapResult> {
    const tenant = await this.createTenant({ name: input.tenantName, slug: input.tenantSlug });
    try {
      const user = await this.createUser({
        tenantId: tenant.id,
        email: input.email,
        passwordHash: input.passwordHash,
      });
      if (!input.workspace) {
        return { tenant, user };
      }
      const workspace = await this.createWorkspace({
        tenantId: tenant.id,
        name: input.workspace.name,
        slug: input.workspace.slug,
        infisicalEnvSlug: input.workspace.infisicalEnvSlug ?? input.workspace.slug,
      });
      await this.upsertMembership({
        userId: user.id,
        workspaceId: workspace.id,
        role: "owner",
      });
      return { tenant, user, workspace };
    } catch (error) {
      // Roll back partial writes so failed register leaves no orphan rows.
      for (const [key, membership] of this.memberships) {
        if (this.users.get(membership.userId)?.tenantId === tenant.id) {
          this.memberships.delete(key);
        }
      }
      for (const [id, workspace] of this.workspaces) {
        if (workspace.tenantId === tenant.id) this.workspaces.delete(id);
      }
      for (const [id, user] of this.users) {
        if (user.tenantId === tenant.id) this.users.delete(id);
      }
      this.tenants.delete(tenant.id);
      throw error;
    }
  }

  async createTenant(input: { name: string; slug: string }): Promise<TenantRow> {
    for (const existing of this.tenants.values()) {
      if (existing.slug === input.slug) {
        throw new StoreConflictError(`tenant slug already exists: ${input.slug}`);
      }
    }
    const ts = now();
    const row: TenantRow = {
      id: randomUUID(),
      name: input.name,
      slug: input.slug,
      createdAt: ts,
      updatedAt: ts,
    };
    this.tenants.set(row.id, row);
    return row;
  }

  async findTenantBySlug(slug: string): Promise<TenantRow | undefined> {
    for (const row of this.tenants.values()) {
      if (row.slug === slug) return row;
    }
    return undefined;
  }

  async findTenantById(id: string): Promise<TenantRow | undefined> {
    return this.tenants.get(id);
  }

  async createUser(input: {
    tenantId: string;
    email: string;
    passwordHash: string;
  }): Promise<UserRow> {
    const email = input.email.toLowerCase();
    for (const existing of this.users.values()) {
      if (existing.tenantId === input.tenantId && existing.email === email) {
        throw new StoreConflictError(`user email already exists in tenant`);
      }
    }
    const ts = now();
    const row: UserRow = {
      id: randomUUID(),
      tenantId: input.tenantId,
      email,
      passwordHash: input.passwordHash,
      createdAt: ts,
      updatedAt: ts,
    };
    this.users.set(row.id, row);
    return row;
  }

  async findUserByTenantEmail(tenantId: string, email: string): Promise<UserRow | undefined> {
    const normalized = email.toLowerCase();
    for (const row of this.users.values()) {
      if (row.tenantId === tenantId && row.email === normalized) return row;
    }
    return undefined;
  }

  async findUserById(id: string): Promise<UserRow | undefined> {
    return this.users.get(id);
  }

  async createWorkspace(input: {
    tenantId: string;
    name: string;
    slug: string;
    infisicalEnvSlug?: string | null;
    defaultCodingBackend?: CodingBackend;
  }): Promise<WorkspaceRow> {
    for (const existing of this.workspaces.values()) {
      if (existing.tenantId === input.tenantId && existing.slug === input.slug) {
        throw new StoreConflictError(`workspace slug already exists in tenant`);
      }
    }
    const ts = now();
    const row: WorkspaceRow = {
      id: randomUUID(),
      tenantId: input.tenantId,
      name: input.name,
      slug: input.slug,
      infisicalEnvSlug: input.infisicalEnvSlug ?? null,
      defaultCodingBackend: input.defaultCodingBackend ?? "cursor-cli",
      createdAt: ts,
      updatedAt: ts,
    };
    this.workspaces.set(row.id, row);
    return row;
  }

  async findWorkspaceById(id: string): Promise<WorkspaceRow | undefined> {
    return this.workspaces.get(id);
  }

  async upsertMembership(input: {
    userId: string;
    workspaceId: string;
    role: MembershipRole;
  }): Promise<MembershipRow> {
    const key = this.membershipKey(input.userId, input.workspaceId);
    const existing = this.memberships.get(key);
    const ts = now();
    const row: MembershipRow = {
      userId: input.userId,
      workspaceId: input.workspaceId,
      role: input.role,
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    };
    this.memberships.set(key, row);
    return row;
  }

  async listMemberships(userId: string): Promise<MembershipView[]> {
    const out: MembershipView[] = [];
    for (const row of this.memberships.values()) {
      if (row.userId !== userId) continue;
      const workspace = this.workspaces.get(row.workspaceId);
      if (!workspace) continue;
      out.push({ ...row, workspace });
    }
    return out;
  }

  async findMembership(userId: string, workspaceId: string): Promise<MembershipRow | undefined> {
    return this.memberships.get(this.membershipKey(userId, workspaceId));
  }

  async listConnections(workspaceId: string): Promise<ConnectionRow[]> {
    return [...this.connections.values()].filter((row) => row.workspaceId === workspaceId);
  }

  async findConnection(
    workspaceId: string,
    connectionId: string,
  ): Promise<ConnectionRow | undefined> {
    const row = this.connections.get(connectionId);
    if (!row || row.workspaceId !== workspaceId) return undefined;
    return row;
  }

  async createConnection(input: {
    workspaceId: string;
    kind: ConnectionKind;
    name: string;
    infisicalSecretPath: string;
    config?: Record<string, unknown>;
    enabled?: boolean;
  }): Promise<ConnectionRow> {
    for (const existing of this.connections.values()) {
      if (
        existing.workspaceId === input.workspaceId &&
        existing.kind === input.kind &&
        existing.name === input.name
      ) {
        throw new StoreConflictError(`connection already exists`);
      }
    }
    const ts = now();
    const row: ConnectionRow = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      kind: input.kind,
      name: input.name,
      infisicalSecretPath: input.infisicalSecretPath,
      config: input.config ?? {},
      enabled: input.enabled ?? true,
      createdAt: ts,
      updatedAt: ts,
    };
    this.connections.set(row.id, row);
    return row;
  }

  async updateConnection(
    workspaceId: string,
    connectionId: string,
    patch: {
      name?: string;
      infisicalSecretPath?: string;
      config?: Record<string, unknown>;
      enabled?: boolean;
    },
  ): Promise<ConnectionRow | undefined> {
    const row = await this.findConnection(workspaceId, connectionId);
    if (!row) return undefined;
    if (patch.name !== undefined) {
      for (const existing of this.connections.values()) {
        if (
          existing.id !== connectionId &&
          existing.workspaceId === workspaceId &&
          existing.kind === row.kind &&
          existing.name === patch.name
        ) {
          throw new StoreConflictError(`connection already exists`);
        }
      }
      row.name = patch.name;
    }
    if (patch.infisicalSecretPath !== undefined) {
      row.infisicalSecretPath = patch.infisicalSecretPath;
    }
    if (patch.config !== undefined) row.config = patch.config;
    if (patch.enabled !== undefined) row.enabled = patch.enabled;
    row.updatedAt = now();
    this.connections.set(row.id, row);
    return row;
  }

  async deleteConnection(workspaceId: string, connectionId: string): Promise<boolean> {
    const row = await this.findConnection(workspaceId, connectionId);
    if (!row) return false;
    this.connections.delete(connectionId);
    return true;
  }

  async listAgents(workspaceId: string): Promise<AgentCatalogRow[]> {
    return [...this.agents.values()].filter((row) => row.workspaceId === workspaceId);
  }

  async listSkills(workspaceId: string): Promise<SkillCatalogRow[]> {
    return [...this.skills.values()].filter((row) => row.workspaceId === workspaceId);
  }

  /** Test helper — seed catalog rows without going through HTTP. */
  seedAgent(row: AgentCatalogRow): void {
    this.agents.set(row.id, row);
  }

  seedSkill(row: SkillCatalogRow): void {
    this.skills.set(row.id, row);
  }
}
