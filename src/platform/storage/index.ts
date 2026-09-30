import { S3Client } from "@aws-sdk/client-s3";
import type { StorageConfig } from "../../config/storage.js";
import type { BlobStore } from "./blob-store.js";
import { FilesystemBlobStore } from "./filesystem.js";
import { InMemoryBlobStore } from "./memory.js";
import { S3BlobStore } from "./s3.js";

export * from "./blob-store.js";
export { FilesystemBlobStore } from "./filesystem.js";
export { InMemoryBlobStore } from "./memory.js";
export { S3BlobStore } from "./s3.js";

export function createBlobStore(config: StorageConfig): BlobStore {
  switch (config.kind) {
    case "memory":
      return new InMemoryBlobStore();
    case "filesystem":
      return new FilesystemBlobStore(config.root);
    case "s3":
      return new S3BlobStore({
        bucket: config.bucket,
        client: new S3Client({
          region: config.region,
          ...(config.endpoint ? { endpoint: config.endpoint, forcePathStyle: true } : {}),
          ...(config.credentials ? { credentials: config.credentials } : {}),
        }),
      });
  }
}
