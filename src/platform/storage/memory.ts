import {
  assertTenantId,
  isSha256Hex,
  sha256Hex,
  type BlobStore,
  type PutBlobOptions,
  type PutBlobResult,
} from "./blob-store.js";

/** Test implementation of the BlobStore port. */
export class InMemoryBlobStore implements BlobStore {
  private readonly tenants = new Map<string, Map<string, Uint8Array>>();

  async put(bytes: Uint8Array, options: PutBlobOptions): Promise<PutBlobResult> {
    assertTenantId(options.tenantId);
    const sha256 = sha256Hex(bytes);
    const blobs = this.tenants.get(options.tenantId) ?? new Map<string, Uint8Array>();
    if (!blobs.has(sha256)) blobs.set(sha256, Uint8Array.from(bytes));
    this.tenants.set(options.tenantId, blobs);
    return { sha256, size: bytes.byteLength };
  }

  async get(tenantId: string, sha256: string): Promise<Uint8Array | null> {
    assertTenantId(tenantId);
    if (!isSha256Hex(sha256)) return null;
    const bytes = this.tenants.get(tenantId)?.get(sha256);
    return bytes ? Uint8Array.from(bytes) : null;
  }

  async has(tenantId: string, sha256: string): Promise<boolean> {
    assertTenantId(tenantId);
    return isSha256Hex(sha256) && (this.tenants.get(tenantId)?.has(sha256) ?? false);
  }

  async deleteTenant(tenantId: string): Promise<void> {
    assertTenantId(tenantId);
    this.tenants.delete(tenantId);
  }

  count(tenantId: string): number {
    return this.tenants.get(tenantId)?.size ?? 0;
  }
}
