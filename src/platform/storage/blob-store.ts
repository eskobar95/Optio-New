import { createHash } from "node:crypto";

/** Bodies larger than this move out of events into the blob store (spec B16). A setting, not a constant of nature. */
export const BLOB_INLINE_THRESHOLD_BYTES = 16 * 1024;

export interface PutBlobOptions {
  tenantId: string;
  /** Advisory. Recorded by implementations that support object metadata (S3); not needed to read the blob back. */
  contentType: string;
}

export interface PutBlobResult {
  sha256: string;
  size: number;
}

/**
 * Content-addressed, tenant-prefixed blob storage.
 * The same bytes put twice for one tenant are stored once; a blob is only reachable with its own tenant id.
 */
export interface BlobStore {
  put(bytes: Uint8Array, options: PutBlobOptions): Promise<PutBlobResult>;
  /** Returns null when the tenant has no blob with this hash (including a hash that belongs to another tenant). */
  get(tenantId: string, sha256: string): Promise<Uint8Array | null>;
  has(tenantId: string, sha256: string): Promise<boolean>;
  /** Removes every blob of this tenant and nothing else. No-op for an unknown tenant. */
  deleteTenant(tenantId: string): Promise<void>;
}

const TENANT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Tenant ids become path segments and key prefixes, so only a safe alphabet is accepted. */
export function assertTenantId(tenantId: string): void {
  if (!TENANT_ID_RE.test(tenantId)) {
    throw new Error(`Invalid tenant id for blob store: ${JSON.stringify(tenantId)}`);
  }
}

export function isSha256Hex(value: string): boolean {
  return SHA256_RE.test(value);
}
