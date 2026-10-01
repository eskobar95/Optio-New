import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { LEGACY_TENANT_ID, LEGACY_WORKSPACE_ID } from "../src/config/tenant.js";
import { runDrizzleMigrations } from "../src/db/migrate-cli.js";
import { closeSharedPool, getSharedPool } from "../src/db/pool.js";
import { withTenant } from "../src/db/with-tenant.js";

const databaseUrl = process.env.OPTIO_NEW_DATABASE_URL?.trim();

describe.skipIf(!databaseUrl)("withTenant against Postgres", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = getSharedPool(databaseUrl as string);
    await pool.query("DROP TABLE IF EXISTS with_tenant_probe");
    await pool.query("CREATE TABLE with_tenant_probe (id text PRIMARY KEY)");
  });

  afterAll(async () => {
    await pool.query("DROP TABLE IF EXISTS with_tenant_probe");
    await closeSharedPool();
  });

  it("scopes app.tenant_id and app.workspace_id to the transaction", async () => {
    const inside = await withTenant(
      pool,
      { tenantId: "tenant-a", workspaceId: "ws-a" },
      async (db) => {
        const res = await db.query(
          "SELECT current_setting('app.tenant_id') AS t, current_setting('app.workspace_id') AS w",
        );
        return res.rows[0];
      },
    );
    expect(inside).toEqual({ t: "tenant-a", w: "ws-a" });
    const after = await pool.query("SELECT current_setting('app.tenant_id', true) AS t");
    expect([null, ""]).toContain(after.rows[0].t);
  });

  it("does not leak the setting to the next user of a pooled connection", async () => {
    const one = await pool.connect();
    try {
      await withTenant(pool, { tenantId: "tenant-b" }, async () => undefined);
      const res = await one.query("SELECT current_setting('app.tenant_id', true) AS t");
      expect([null, ""]).toContain(res.rows[0].t);
    } finally {
      one.release();
    }
  });

  it("commits writes on success", async () => {
    await withTenant(pool, { tenantId: "t" }, (db) =>
      db.query("INSERT INTO with_tenant_probe (id) VALUES ('ok')"),
    );
    const res = await pool.query("SELECT id FROM with_tenant_probe WHERE id = 'ok'");
    expect(res.rows).toHaveLength(1);
  });

  it("rolls back every write when fn throws", async () => {
    await expect(
      withTenant(pool, { tenantId: "t" }, async (db) => {
        await db.query("INSERT INTO with_tenant_probe (id) VALUES ('r1')");
        await db.query("INSERT INTO with_tenant_probe (id) VALUES ('r2')");
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    const res = await pool.query("SELECT id FROM with_tenant_probe WHERE id IN ('r1','r2')");
    expect(res.rows).toHaveLength(0);
  });
});

describe.skipIf(!databaseUrl)("legacy tenant migration", () => {
  it("has the legacy tenant and workspace after migrate, and migrate is repeatable", async () => {
    await runDrizzleMigrations(databaseUrl);
    await runDrizzleMigrations(databaseUrl);
    const pool = getSharedPool(databaseUrl as string);
    try {
      const t = await pool.query("SELECT slug FROM optio.tenants WHERE id = $1", [
        LEGACY_TENANT_ID,
      ]);
      const w = await pool.query("SELECT tenant_id FROM optio.workspaces WHERE id = $1", [
        LEGACY_WORKSPACE_ID,
      ]);
      expect(t.rows[0]?.slug).toBe("legacy");
      expect(w.rows[0]?.tenant_id).toBe(LEGACY_TENANT_ID);
    } finally {
      await closeSharedPool();
    }
  });
});
