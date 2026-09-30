import { describe, expect, it } from "vitest";
import type { BlobStore } from "../src/platform/storage/blob-store.js";
import { sha256Hex } from "../src/platform/storage/blob-store.js";

export interface BlobStoreHarness {
  store: BlobStore;
  /** Number of physical objects stored for a tenant (used to prove "written once"). */
  countBlobs(tenantId: string): Promise<number>;
  cleanup(): Promise<void>;
}

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const unique = (): string =>
  `t${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

/** One contract for every BlobStore implementation. */
export function blobStoreContract(
  name: string,
  create: () => Promise<BlobStoreHarness>,
  options: { skip?: boolean } = {},
): void {
  describe.skipIf(options.skip === true)(`BlobStore contract: ${name}`, () => {
    async function withHarness(run: (h: BlobStoreHarness) => Promise<void>): Promise<void> {
      const harness = await create();
      try {
        await run(harness);
      } finally {
        await harness.cleanup();
      }
    }

    it("put returns the sha256 and size, and get returns the same bytes", () =>
      withHarness(async ({ store }) => {
        const tenantId = unique();
        const bytes = enc("hello blob");
        const result = await store.put(bytes, { tenantId, contentType: "text/plain" });
        expect(result).toEqual({ sha256: sha256Hex(bytes), size: bytes.byteLength });
        const got = await store.get(tenantId, result.sha256);
        expect(got).not.toBeNull();
        expect(Buffer.from(got as Uint8Array).equals(Buffer.from(bytes))).toBe(true);
        expect(await store.has(tenantId, result.sha256)).toBe(true);
      }));

    it("stores binary and empty bodies unchanged", () =>
      withHarness(async ({ store }) => {
        const tenantId = unique();
        const binary = Uint8Array.from([0, 255, 10, 13, 128, 1]);
        const a = await store.put(binary, { tenantId, contentType: "application/octet-stream" });
        const b = await store.put(new Uint8Array(0), { tenantId, contentType: "text/plain" });
        expect(Buffer.from((await store.get(tenantId, a.sha256)) as Uint8Array)).toEqual(
          Buffer.from(binary),
        );
        expect(b.size).toBe(0);
        expect(await store.get(tenantId, b.sha256)).toEqual(new Uint8Array(0));
      }));

    it("put of identical bytes returns the same hash and writes once", () =>
      withHarness(async ({ store, countBlobs }) => {
        const tenantId = unique();
        const bytes = enc("same bytes");
        const first = await store.put(bytes, { tenantId, contentType: "text/plain" });
        const second = await store.put(bytes, { tenantId, contentType: "text/plain" });
        expect(second).toEqual(first);
        expect(await countBlobs(tenantId)).toBe(1);
      }));

    it("get and has report not found for an unknown hash", () =>
      withHarness(async ({ store }) => {
        const tenantId = unique();
        const missing = sha256Hex(enc("never stored"));
        expect(await store.get(tenantId, missing)).toBeNull();
        expect(await store.has(tenantId, missing)).toBe(false);
      }));

    it("get and has treat a malformed hash as not found", () =>
      withHarness(async ({ store }) => {
        const tenantId = unique();
        for (const bad of ["", "../../etc/passwd", "abc", "Z".repeat(64)]) {
          expect(await store.get(tenantId, bad)).toBeNull();
          expect(await store.has(tenantId, bad)).toBe(false);
        }
      }));

    it("get with another tenant's id returns not found", () =>
      withHarness(async ({ store }) => {
        const owner = unique();
        const other = unique();
        const { sha256 } = await store.put(enc("tenant a secret"), {
          tenantId: owner,
          contentType: "text/plain",
        });
        expect(await store.get(other, sha256)).toBeNull();
        expect(await store.has(other, sha256)).toBe(false);
        expect(await store.has(owner, sha256)).toBe(true);
      }));

    it("the same bytes under two tenants are stored separately", () =>
      withHarness(async ({ store, countBlobs }) => {
        const a = unique();
        const b = unique();
        const bytes = enc("shared content");
        await store.put(bytes, { tenantId: a, contentType: "text/plain" });
        await store.put(bytes, { tenantId: b, contentType: "text/plain" });
        expect(await countBlobs(a)).toBe(1);
        expect(await countBlobs(b)).toBe(1);
      }));

    it("deleteTenant removes all of that tenant's blobs and none of another tenant's", () =>
      withHarness(async ({ store, countBlobs }) => {
        const doomed = unique();
        const kept = unique();
        const one = await store.put(enc("one"), { tenantId: doomed, contentType: "text/plain" });
        const two = await store.put(enc("two"), { tenantId: doomed, contentType: "text/plain" });
        const survivor = await store.put(enc("one"), { tenantId: kept, contentType: "text/plain" });

        await store.deleteTenant(doomed);

        expect(await store.has(doomed, one.sha256)).toBe(false);
        expect(await store.has(doomed, two.sha256)).toBe(false);
        expect(await countBlobs(doomed)).toBe(0);
        expect(await store.has(kept, survivor.sha256)).toBe(true);
        expect(await countBlobs(kept)).toBe(1);
      }));

    it("deleteTenant does not touch a tenant whose id starts with the same characters", () =>
      withHarness(async ({ store }) => {
        const prefix = unique();
        const longer = `${prefix}x`;
        const { sha256 } = await store.put(enc("prefix"), {
          tenantId: longer,
          contentType: "text/plain",
        });
        await store.deleteTenant(prefix);
        expect(await store.has(longer, sha256)).toBe(true);
      }));

    it("deleteTenant on an unknown tenant is a no-op", () =>
      withHarness(async ({ store }) => {
        await expect(store.deleteTenant(unique())).resolves.toBeUndefined();
      }));

    it("rejects tenant ids that are not safe path segments", () =>
      withHarness(async ({ store }) => {
        for (const bad of ["", "..", "a/b", "a\\b", "../other", "with space"]) {
          await expect(
            store.put(enc("x"), { tenantId: bad, contentType: "text/plain" }),
          ).rejects.toThrow(/tenant/i);
          await expect(store.get(bad, "0".repeat(64))).rejects.toThrow(/tenant/i);
          await expect(store.has(bad, "0".repeat(64))).rejects.toThrow(/tenant/i);
          await expect(store.deleteTenant(bad)).rejects.toThrow(/tenant/i);
        }
      }));
  });
}
