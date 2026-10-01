/** Tenant and workspace every transaction runs as. */
export interface TenantContext {
  tenantId: string;
  workspaceId?: string;
}

/** Created by migration 0005; used when config names no tenant. */
export const LEGACY_TENANT_ID = "00000000-0000-4000-8000-000000000001";
export const LEGACY_WORKSPACE_ID = "00000000-0000-4000-8000-000000000002";

/** `OPTIO_TENANT_ID` / `OPTIO_WORKSPACE_ID`, else the legacy tenant and workspace. */
export function resolveTenantContext(env: NodeJS.ProcessEnv = process.env): TenantContext {
  const tenantId = env.OPTIO_TENANT_ID?.trim();
  if (!tenantId) {
    return { tenantId: LEGACY_TENANT_ID, workspaceId: LEGACY_WORKSPACE_ID };
  }
  const workspaceId = env.OPTIO_WORKSPACE_ID?.trim();
  return workspaceId ? { tenantId, workspaceId } : { tenantId };
}
