export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export type StorageConfig =
  | { kind: "filesystem"; root: string }
  | { kind: "memory" }
  | {
      kind: "s3";
      bucket: string;
      endpoint?: string;
      region: string;
      /** Absent means the AWS SDK default provider chain (instance role, profile). */
      credentials?: S3Credentials;
    };

export const DEFAULT_BLOB_FS_ROOT = "state/blobs";
export const DEFAULT_S3_REGION = "us-east-1";

function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/**
 * Blob storage settings from env. Default: filesystem under `OPTIO_NEW_BLOB_FS_ROOT`.
 * S3 credentials come only from env (injected by the secret handling, see docs/secrets.md), never from code.
 */
export function loadStorageConfig(env: NodeJS.ProcessEnv = process.env): StorageConfig {
  const kind = (read(env, "OPTIO_NEW_BLOB_STORE") ?? "filesystem").toLowerCase();
  if (kind === "memory") return { kind: "memory" };
  if (kind === "filesystem") {
    return {
      kind: "filesystem",
      root: read(env, "OPTIO_NEW_BLOB_FS_ROOT") ?? DEFAULT_BLOB_FS_ROOT,
    };
  }
  if (kind === "s3") {
    const bucket = read(env, "OPTIO_NEW_S3_BUCKET");
    if (!bucket) throw new Error("OPTIO_NEW_BLOB_STORE=s3 requires OPTIO_NEW_S3_BUCKET");
    const accessKeyId = read(env, "OPTIO_NEW_S3_ACCESS_KEY_ID");
    const secretAccessKey = read(env, "OPTIO_NEW_S3_SECRET_ACCESS_KEY");
    if (accessKeyId && !secretAccessKey) {
      throw new Error("OPTIO_NEW_S3_ACCESS_KEY_ID requires OPTIO_NEW_S3_SECRET_ACCESS_KEY");
    }
    if (secretAccessKey && !accessKeyId) {
      throw new Error("OPTIO_NEW_S3_SECRET_ACCESS_KEY requires OPTIO_NEW_S3_ACCESS_KEY_ID");
    }
    const endpoint = read(env, "OPTIO_NEW_S3_ENDPOINT");
    return {
      kind: "s3",
      bucket,
      ...(endpoint ? { endpoint } : {}),
      region: read(env, "OPTIO_NEW_S3_REGION") ?? DEFAULT_S3_REGION,
      ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
    };
  }
  throw new Error(`OPTIO_NEW_BLOB_STORE must be filesystem, s3 or memory, got "${kind}"`);
}
