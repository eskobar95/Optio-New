import { describe, expect, it } from "vitest";
import type pg from "pg";
import {
  LEGACY_TENANT_ID,
  LEGACY_WORKSPACE_ID,
  resolveTenantContext,
} from "../src/config/tenant.js";
import { tenantExecutor, withTenant } from "../src/db/with-tenant.js";

function fakePool(failOn?: string): { pool: pg.Pool; log: string[]; released: () => number } {
  const log: string[] = [];
  let released = 0;
  const client = {
    async query(sql: string, params?: unknown[]) {
      log.push(params ? `${sql} ${JSON.stringify(params)}` : sql);
      if (failOn && sql.includes(failOn)) throw new Error("boom");
      return { rows: [{ ok: 1 }] };
    },
    release() {
      released += 1;
    },
  };
  const pool = { connect: async () => client } as unknown as pg.Pool;
  return { pool, log, released: () => released };
}

describe("withTenant", () => {
  it("sets tenant and workspace locally, then commits", async () => {
    const { pool, log, released } = fakePool();
    const out = await withTenant(pool, { tenantId: "t1", workspaceId: "w1" }, async (db) => {
      await db.query("SELECT 1");
      return "done";
    });
    expect(out).toBe("done");
    expect(log).toEqual([
      "BEGIN",
      `SELECT set_config('app.tenant_id', $1, true) ["t1"]`,
      `SELECT set_config('app.workspace_id', $1, true) ["w1"]`,
      "SELECT 1",
      "COMMIT",
    ]);
    expect(released()).toBe(1);
  });

  it("skips the workspace setting when none is given", async () => {
    const { pool, log } = fakePool();
    await withTenant(pool, { tenantId: "t1" }, async () => undefined);
    expect(log.some((l) => l.includes("app.workspace_id"))).toBe(false);
  });

  it("rolls back, releases and rethrows when fn throws", async () => {
    const { pool, log, released } = fakePool();
    await expect(
      withTenant(pool, { tenantId: "t1" }, async () => {
        throw new Error("fn failed");
      }),
    ).rejects.toThrow("fn failed");
    expect(log.at(-1)).toBe("ROLLBACK");
    expect(log).not.toContain("COMMIT");
    expect(released()).toBe(1);
  });

  it("surfaces the original error when ROLLBACK itself fails", async () => {
    const { pool } = fakePool("ROLLBACK");
    await expect(
      withTenant(pool, { tenantId: "t1" }, async () => {
        throw new Error("fn failed");
      }),
    ).rejects.toThrow("fn failed");
  });

  it("tenantExecutor runs each query in its own tenant transaction", async () => {
    const { pool, log } = fakePool();
    await tenantExecutor(pool, { tenantId: "t1" }).query("SELECT 2", [1]);
    expect(log).toEqual([
      "BEGIN",
      `SELECT set_config('app.tenant_id', $1, true) ["t1"]`,
      "SELECT 2 [1]",
      "COMMIT",
    ]);
  });
});

describe("resolveTenantContext", () => {
  it("falls back to the legacy tenant and workspace", () => {
    expect(resolveTenantContext({})).toEqual({
      tenantId: LEGACY_TENANT_ID,
      workspaceId: LEGACY_WORKSPACE_ID,
    });
  });

  it("uses configured ids", () => {
    expect(resolveTenantContext({ OPTIO_TENANT_ID: "t", OPTIO_WORKSPACE_ID: "w" })).toEqual({
      tenantId: "t",
      workspaceId: "w",
    });
    expect(resolveTenantContext({ OPTIO_TENANT_ID: "t" })).toEqual({ tenantId: "t" });
  });
});

describe("shared pool", () => {
  it("is the only place besides the migration CLI that creates a pg.Pool", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (
          entry.name.endsWith(".ts") &&
          /new (pg\.)?Pool\(/.test(readFileSync(full, "utf8"))
        ) {
          offenders.push(full);
        }
      }
    };
    walk("src");
    expect(offenders.sort()).toEqual([
      join("src", "db", "migrate-cli.ts"),
      join("src", "db", "pool.ts"),
    ]);
  });
});
