import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  assertTenantId,
  isSha256Hex,
  sha256Hex,
  type BlobStore,
  type PutBlobOptions,
  type PutBlobResult,
} from "./blob-store.js";

export interface S3BlobStoreOptions {
  client: S3Client;
  bucket: string;
}

function isMissing(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } } | undefined;
  return e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404;
}

/** S3-compatible BlobStore (AWS S3, MinIO, R2). Keys are `<tenant>/<sha>`. */
export class S3BlobStore implements BlobStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(options: S3BlobStoreOptions) {
    this.client = options.client;
    this.bucket = options.bucket;
  }

  private key(tenantId: string, sha256: string): string {
    return `${tenantId}/${sha256}`;
  }

  /** Creates the bucket when it does not exist. Used by tests and local setups; production buckets are provisioned. */
  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      if (!isMissing(error)) throw error;
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  async put(bytes: Uint8Array, options: PutBlobOptions): Promise<PutBlobResult> {
    assertTenantId(options.tenantId);
    const sha256 = sha256Hex(bytes);
    if (!(await this.has(options.tenantId, sha256))) {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.key(options.tenantId, sha256),
          Body: bytes,
          ContentType: options.contentType,
        }),
      );
    }
    return { sha256, size: bytes.byteLength };
  }

  async get(tenantId: string, sha256: string): Promise<Uint8Array | null> {
    assertTenantId(tenantId);
    if (!isSha256Hex(sha256)) return null;
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.key(tenantId, sha256) }),
      );
      return (await out.Body?.transformToByteArray()) ?? new Uint8Array(0);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async has(tenantId: string, sha256: string): Promise<boolean> {
    assertTenantId(tenantId);
    if (!isSha256Hex(sha256)) return false;
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(tenantId, sha256) }),
      );
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  async deleteTenant(tenantId: string): Promise<void> {
    assertTenantId(tenantId);
    const prefix = `${tenantId}/`;
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      const objects = (page.Contents ?? []).map((o) => ({ Key: o.Key as string }));
      if (objects.length > 0) {
        await this.client.send(
          new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: objects } }),
        );
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
  }
}
