import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { loadStorageConfig } from "../src/config/storage.js";
import { BLOB_INLINE_THRESHOLD_BYTES } from "../src/platform/storage/blob-store.js";
import { createBlobStore } from "../src/platform/storage/index.js";
import { FilesystemBlobStore } from "../src/platform/storage/filesystem.js";
import { InMemoryBlobStore } from "../src/platform/storage/memory.js";
import { S3BlobStore } from "../src/platform/storage/s3.js";
import { blobStoreContract } from "./blob-store.contract.js";
import { startFakeS3 } from "./fixtures/fake-s3-server.js";

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map((e) =>
      e.isDirectory()
        ? listFiles(path.join(dir, e.name))
        : Promise.resolve([path.join(dir, e.name)]),
    ),
  );
  return nested.flat();
}

blobStoreContract("in-memory", async () => {
  const store = new InMemoryBlobStore();
  return { store, countBlobs: async (tenantId) => store.count(tenantId), cleanup: async () => {} };
});

blobStoreContract("filesystem", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "optio-blobs-"));
  const store = new FilesystemBlobStore(root);
  return {
    store,
    countBlobs: async (tenantId) => (await listFiles(path.join(root, tenantId))).length,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
});

blobStoreContract("s3 protocol (in-process fake, not MinIO)", async () => {
  const fake = await startFakeS3();
  const client = new S3Client({
    endpoint: fake.endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: "fake", secretAccessKey: "fake" },
  });
  return {
    store: new S3BlobStore({ client, bucket: "b" }),
    countBlobs: async (tenantId) =>
      [...fake.objects.keys()].filter((k) => k.startsWith(`b/${tenantId}/`)).length,
    cleanup: async () => {
      client.destroy();
      await fake.close();
    },
  };
});

const s3Endpoint = process.env.OPTIO_TEST_S3_ENDPOINT;
const s3AccessKeyId = process.env.OPTIO_TEST_S3_ACCESS_KEY_ID;
const s3SecretAccessKey = process.env.OPTIO_TEST_S3_SECRET_ACCESS_KEY;
const s3Bucket = process.env.OPTIO_TEST_S3_BUCKET ?? "optio-blob-contract";

async function s3Reachable(): Promise<boolean> {
  if (!s3Endpoint || !s3AccessKeyId || !s3SecretAccessKey) return false;
  try {
    await fetch(s3Endpoint, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

const s3Available = await s3Reachable();
if (!s3Available) {
  console.warn(
    "[blob-store] S3-compatible contract run SKIPPED: set OPTIO_TEST_S3_ENDPOINT, OPTIO_TEST_S3_ACCESS_KEY_ID and OPTIO_TEST_S3_SECRET_ACCESS_KEY and start a MinIO container to run it.",
  );
}

blobStoreContract(
  "s3-compatible (MinIO)",
  async () => {
    const client = new S3Client({
      endpoint: s3Endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: s3AccessKeyId!, secretAccessKey: s3SecretAccessKey! },
    });
    const store = new S3BlobStore({ client, bucket: s3Bucket });
    await store.ensureBucket();
    const keysFor = async (tenantId: string): Promise<string[]> => {
      const out = await client.send(
        new ListObjectsV2Command({ Bucket: s3Bucket, Prefix: `${tenantId}/` }),
      );
      return (out.Contents ?? []).map((o) => o.Key as string);
    };
    return {
      store,
      countBlobs: async (tenantId) => (await keysFor(tenantId)).length,
      cleanup: async () => {
        const out = await client.send(new ListObjectsV2Command({ Bucket: s3Bucket }));
        const objects = (out.Contents ?? []).map((o) => ({ Key: o.Key as string }));
        if (objects.length > 0) {
          await client.send(
            new DeleteObjectsCommand({ Bucket: s3Bucket, Delete: { Objects: objects } }),
          );
        }
        client.destroy();
      },
    };
  },
  { skip: !s3Available },
);

describe("filesystem layout", () => {
  it("stores a blob at <root>/<tenant>/<sha[0:2]>/<sha>", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "optio-blobs-"));
    try {
      const store = new FilesystemBlobStore(root);
      const { sha256 } = await store.put(new TextEncoder().encode("layout"), {
        tenantId: "tenant-1",
        contentType: "text/plain",
      });
      expect(await listFiles(root)).toEqual([
        path.join(root, "tenant-1", sha256.slice(0, 2), sha256),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("storage config", () => {
  it("defaults to the filesystem implementation", () => {
    const config = loadStorageConfig({});
    expect(config.kind).toBe("filesystem");
    expect(createBlobStore(config)).toBeInstanceOf(FilesystemBlobStore);
  });

  it("reads the filesystem root from env", () => {
    expect(loadStorageConfig({ OPTIO_NEW_BLOB_FS_ROOT: "/data/blobs" })).toEqual({
      kind: "filesystem",
      root: "/data/blobs",
    });
  });

  it("selects memory", () => {
    const config = loadStorageConfig({ OPTIO_NEW_BLOB_STORE: "memory" });
    expect(createBlobStore(config)).toBeInstanceOf(InMemoryBlobStore);
  });

  it("selects s3 with bucket and endpoint from env and credentials from env only", () => {
    const config = loadStorageConfig({
      OPTIO_NEW_BLOB_STORE: "s3",
      OPTIO_NEW_S3_BUCKET: "blobs",
      OPTIO_NEW_S3_ENDPOINT: "http://localhost:9000",
      OPTIO_NEW_S3_REGION: "eu-north-1",
      OPTIO_NEW_S3_ACCESS_KEY_ID: "id",
      OPTIO_NEW_S3_SECRET_ACCESS_KEY: "secret",
    });
    expect(config).toEqual({
      kind: "s3",
      bucket: "blobs",
      endpoint: "http://localhost:9000",
      region: "eu-north-1",
      credentials: { accessKeyId: "id", secretAccessKey: "secret" },
    });
    expect(createBlobStore(config)).toBeInstanceOf(S3BlobStore);
  });

  it("s3 without a bucket is a config error", () => {
    expect(() => loadStorageConfig({ OPTIO_NEW_BLOB_STORE: "s3" })).toThrow(/OPTIO_NEW_S3_BUCKET/);
  });

  it("s3 with only one half of the credentials is a config error", () => {
    expect(() =>
      loadStorageConfig({
        OPTIO_NEW_BLOB_STORE: "s3",
        OPTIO_NEW_S3_BUCKET: "blobs",
        OPTIO_NEW_S3_ACCESS_KEY_ID: "id",
      }),
    ).toThrow(/OPTIO_NEW_S3_SECRET_ACCESS_KEY/);
  });

  it("an unknown implementation is a config error", () => {
    expect(() => loadStorageConfig({ OPTIO_NEW_BLOB_STORE: "gcs" })).toThrow(
      /OPTIO_NEW_BLOB_STORE/,
    );
  });
});

describe("inline threshold", () => {
  it("is 16 KiB", () => {
    expect(BLOB_INLINE_THRESHOLD_BYTES).toBe(16 * 1024);
  });
});
