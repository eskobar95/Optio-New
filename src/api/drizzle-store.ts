/**
 * Drizzle-backed OptioApiStore (ENG-23).
 */
import { and, eq } from "drizzle-orm";
import type { OptioDb } from "../db/client.js";
import {
  agents,
  connections,
  skills,
  tenants,
  users,
  workspaceMemberships,
  workspaces,
} from "../db/schema/optio/index.js";
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
  type SkillCatalogRow,
  type TenantRow,
  type UserRow,
  type WorkspaceRow,
} from "./store.js";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  );
}

function mapTenant(row: typeof tenants.$inferSelect): TenantRow {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapUser(row: typeof users.$inferSelect): UserRow {
  return {
    id: row.id,
    tenantId: row.tenantId,
    email: row.email,
    passwordHash: row.passwordHash,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapWorkspace(row: typeof workspaces.$inferSelect): WorkspaceRow {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    slug: row.slug,
    infisicalEnvSlug: row.infisicalEnvSlug,
    defaultCodingBackend: row.defaultCodingBackend as CodingBackend,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapMembership(row: typeof workspaceMemberships.$inferSelect): MembershipRow {
  return {
    userId: row.userId,
    workspaceId: row.workspaceId,
    role: row.role as MembershipRole,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapConnection(row: typeof connections.$inferSelect): ConnectionRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    kind: row.kind as ConnectionKind,
    name: row.name,
    infisicalSecretPath: row.infisicalSecretPath,
    config: (row.config ?? {}) as Record<string, unknown>,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createDrizzleOptioApiStore(db: OptioDb): OptioApiStore {
  return {
    async createTenant(input) {
      try {
        const [row] = await db
          .insert(tenants)
          .values({ name: input.name, slug: input.slug })
          .returning();
        if (!row) throw new Error("tenant insert returned no row");
        return mapTenant(row);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new StoreConflictError(`tenant slug already exists: ${input.slug}`);
        }
        throw error;
      }
    },

    async findTenantBySlug(slug) {
      const [row] = await db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
      return row ? mapTenant(row) : undefined;
    },

    async findTenantById(id) {
      const [row] = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
      return row ? mapTenant(row) : undefined;
    },

    async createUser(input) {
      try {
        const [row] = await db
          .insert(users)
          .values({
            tenantId: input.tenantId,
            email: input.email.toLowerCase(),
            passwordHash: input.passwordHash,
          })
          .returning();
        if (!row) throw new Error("user insert returned no row");
        return mapUser(row);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new StoreConflictError(`user email already exists in tenant`);
        }
        throw error;
      }
    },

    async findUserByTenantEmail(tenantId, email) {
      const [row] = await db
        .select()
        .from(users)
        .where(and(eq(users.tenantId, tenantId), eq(users.email, email.toLowerCase())))
        .limit(1);
      return row ? mapUser(row) : undefined;
    },

    async findUserById(id) {
      const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
      return row ? mapUser(row) : undefined;
    },

    async createWorkspace(input) {
      try {
        const [row] = await db
          .insert(workspaces)
          .values({
            tenantId: input.tenantId,
            name: input.name,
            slug: input.slug,
            infisicalEnvSlug: input.infisicalEnvSlug ?? null,
            defaultCodingBackend: input.defaultCodingBackend ?? "cursor-cli",
          })
          .returning();
        if (!row) throw new Error("workspace insert returned no row");
        return mapWorkspace(row);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new StoreConflictError(`workspace slug already exists in tenant`);
        }
        throw error;
      }
    },

    async findWorkspaceById(id) {
      const [row] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
      return row ? mapWorkspace(row) : undefined;
    },

    async upsertMembership(input) {
      const [row] = await db
        .insert(workspaceMemberships)
        .values({
          userId: input.userId,
          workspaceId: input.workspaceId,
          role: input.role,
        })
        .onConflictDoUpdate({
          target: [workspaceMemberships.userId, workspaceMemberships.workspaceId],
          set: { role: input.role, updatedAt: new Date() },
        })
        .returning();
      if (!row) throw new Error("membership upsert returned no row");
      return mapMembership(row);
    },

    async listMemberships(userId) {
      const rows = await db
        .select({
          membership: workspaceMemberships,
          workspace: workspaces,
        })
        .from(workspaceMemberships)
        .innerJoin(workspaces, eq(workspaceMemberships.workspaceId, workspaces.id))
        .where(eq(workspaceMemberships.userId, userId));
      return rows.map((row): MembershipView => ({
        ...mapMembership(row.membership),
        workspace: mapWorkspace(row.workspace),
      }));
    },

    async findMembership(userId, workspaceId) {
      const [row] = await db
        .select()
        .from(workspaceMemberships)
        .where(
          and(
            eq(workspaceMemberships.userId, userId),
            eq(workspaceMemberships.workspaceId, workspaceId),
          ),
        )
        .limit(1);
      return row ? mapMembership(row) : undefined;
    },

    async listConnections(workspaceId) {
      const rows = await db
        .select()
        .from(connections)
        .where(eq(connections.workspaceId, workspaceId));
      return rows.map(mapConnection);
    },

    async findConnection(workspaceId, connectionId) {
      const [row] = await db
        .select()
        .from(connections)
        .where(and(eq(connections.workspaceId, workspaceId), eq(connections.id, connectionId)))
        .limit(1);
      return row ? mapConnection(row) : undefined;
    },

    async createConnection(input) {
      try {
        const [row] = await db
          .insert(connections)
          .values({
            workspaceId: input.workspaceId,
            kind: input.kind,
            name: input.name,
            infisicalSecretPath: input.infisicalSecretPath,
            config: input.config ?? {},
            enabled: input.enabled ?? true,
          })
          .returning();
        if (!row) throw new Error("connection insert returned no row");
        return mapConnection(row);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new StoreConflictError(`connection already exists`);
        }
        throw error;
      }
    },

    async updateConnection(workspaceId, connectionId, patch) {
      const existing = await this.findConnection(workspaceId, connectionId);
      if (!existing) return undefined;
      try {
        const [row] = await db
          .update(connections)
          .set({
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.infisicalSecretPath !== undefined
              ? { infisicalSecretPath: patch.infisicalSecretPath }
              : {}),
            ...(patch.config !== undefined ? { config: patch.config } : {}),
            ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
            updatedAt: new Date(),
          })
          .where(and(eq(connections.workspaceId, workspaceId), eq(connections.id, connectionId)))
          .returning();
        return row ? mapConnection(row) : undefined;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new StoreConflictError(`connection already exists`);
        }
        throw error;
      }
    },

    async deleteConnection(workspaceId, connectionId) {
      const deleted = await db
        .delete(connections)
        .where(and(eq(connections.workspaceId, workspaceId), eq(connections.id, connectionId)))
        .returning({ id: connections.id });
      return deleted.length > 0;
    },

    async listAgents(workspaceId): Promise<AgentCatalogRow[]> {
      const rows = await db
        .select({
          id: agents.id,
          workspaceId: agents.workspaceId,
          name: agents.name,
          kind: agents.kind,
          model: agents.model,
          enabled: agents.enabled,
        })
        .from(agents)
        .where(eq(agents.workspaceId, workspaceId));
      return rows;
    },

    async listSkills(workspaceId): Promise<SkillCatalogRow[]> {
      const rows = await db
        .select({
          id: skills.id,
          workspaceId: skills.workspaceId,
          name: skills.name,
          slug: skills.slug,
          description: skills.description,
          enabled: skills.enabled,
        })
        .from(skills)
        .where(eq(skills.workspaceId, workspaceId));
      return rows;
    },
  };
}
