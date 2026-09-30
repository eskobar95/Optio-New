import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertTenantId,
  isSha256Hex,
  sha256Hex,
  type BlobStore,
  type PutBlobOptions,
  type PutBlobResult,
} from "./blob-store.js";

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** Default BlobStore: `<root>/<tenant>/<sha[0:2]>/<sha>`. */
export class FilesystemBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  private blobPath(tenantId: string, sha256: string): string {
    return path.join(this.root, tenantId, sha256.slice(0, 2), sha256);
  }

  async put(bytes: Uint8Array, options: PutBlobOptions): Promise<PutBlobResult> {
    assertTenantId(options.tenantId);
    const sha256 = sha256Hex(bytes);
    const target = this.blobPath(options.tenantId, sha256);
    if (!(await this.exists(target))) {
      await mkdir(path.dirname(target), { recursive: true });
      const temp = `${target}.${randomUUID()}.tmp`;
      await writeFile(temp, bytes);
      await rename(temp, target);
    }
    return { sha256, size: bytes.byteLength };
  }

  async get(tenantId: string, sha256: string): Promise<Uint8Array | null> {
    assertTenantId(tenantId);
    if (!isSha256Hex(sha256)) return null;
    try {
      return new Uint8Array(await readFile(this.blobPath(tenantId, sha256)));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async has(tenantId: string, sha256: string): Promise<boolean> {
    assertTenantId(tenantId);
    return isSha256Hex(sha256) && this.exists(this.blobPath(tenantId, sha256));
  }

  async deleteTenant(tenantId: string): Promise<void> {
    assertTenantId(tenantId);
    await rm(path.join(this.root, tenantId), { recursive: true, force: true });
  }

  private async exists(file: string): Promise<boolean> {
    try {
      return (await stat(file)).isFile();
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }
}
