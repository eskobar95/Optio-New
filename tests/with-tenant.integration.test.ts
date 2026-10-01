import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { LEGACY_TENANT_ID, LEGACY_WORKSPACE_ID } from "../src/config/tenant.js";
import { runDrizzleMigrations } from "../src/db/migrate-cli.js";
import { closeSharedPool, getSharedPool } from "../src/db/pool.js";
import { createDrizzleOptioApiStore, StoreConflictError } from "../src/api/index.js";
import { createDb } from "../src/db/client.js";
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

async function withScratchDatabase(run: (url: string) => Promise<void>): Promise<void> {
  const name = `opt13_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  const scratch = new URL(databaseUrl as string);
  scratch.pathname = `/${name}`;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    await run(scratch.toString());
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
}

/** A copy of `drizzle/` holding only migrations up to and including `idx`. */
function migrationsUpTo(idx: number): string {
  const dir = mkdtempSync(join(tmpdir(), "opt13-migrations-"));
  cpSync("drizzle", dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { idx: number; tag: string }[];
  };
  for (const entry of journal.entries.filter((e) => e.idx > idx)) {
    rmSync(join(dir, `${entry.tag}.sql`));
  }
  journal.entries = journal.entries.filter((e) => e.idx <= idx);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

async function legacyRows(client: pg.Client): Promise<{ tenant?: string; workspace?: string }> {
  const t = await client.query("SELECT slug FROM optio.tenants WHERE id = $1", [LEGACY_TENANT_ID]);
  const w = await client.query("SELECT tenant_id FROM optio.workspaces WHERE id = $1", [
    LEGACY_WORKSPACE_ID,
  ]);
  return { tenant: t.rows[0]?.slug, workspace: w.rows[0]?.tenant_id };
}

describe.skipIf(!databaseUrl)("legacy tenant migration", () => {
  it("creates the legacy tenant and workspace on an empty database, repeatably", async () => {
    await withScratchDatabase(async (url) => {
      await runDrizzleMigrations(url);
      await runDrizzleMigrations(url);
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        expect(await legacyRows(client)).toEqual({
          tenant: "legacy",
          workspace: LEGACY_TENANT_ID,
        });
      } finally {
        await client.end();
      }
    });
  });

  it("keeps existing rows and adds the legacy tenant on a database with data", async () => {
    await withScratchDatabase(async (url) => {
      await runDrizzleMigrations(url, migrationsUpTo(4));
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        const tenant = await client.query(
          "INSERT INTO optio.tenants (name, slug) VALUES ('Acme', 'acme') RETURNING id",
        );
        const tenantId = tenant.rows[0].id as string;
        await client.query(
          "INSERT INTO optio.workspaces (tenant_id, name, slug) VALUES ($1, 'Factory', 'factory')",
          [tenantId],
        );
        await runDrizzleMigrations(url);
        await runDrizzleMigrations(url);
        const slugs = await client.query("SELECT slug FROM optio.tenants ORDER BY slug");
        expect(slugs.rows.map((r) => r.slug)).toEqual(["acme", "legacy"]);
        const ws = await client.query("SELECT slug FROM optio.workspaces ORDER BY slug");
        expect(ws.rows.map((r) => r.slug)).toEqual(["factory", "legacy"]);
        expect(await legacyRows(client)).toEqual({ tenant: "legacy", workspace: LEGACY_TENANT_ID });
      } finally {
        await client.end();
      }
    });
  });

  it("still creates the legacy ids when slug legacy is already taken by other rows", async () => {
    await withScratchDatabase(async (url) => {
      await runDrizzleMigrations(url, migrationsUpTo(4));
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        const tenant = await client.query(
          "INSERT INTO optio.tenants (name, slug) VALUES ('Mine', 'legacy') RETURNING id",
        );
        const tenantId = tenant.rows[0].id as string;
        await client.query(
          "INSERT INTO optio.workspaces (tenant_id, name, slug) VALUES ($1, 'Mine', 'legacy')",
          [tenantId],
        );
        await runDrizzleMigrations(url);
        await runDrizzleMigrations(url);
        const own = await client.query("SELECT id FROM optio.tenants WHERE slug = 'legacy'");
        expect(own.rows.map((r) => r.id)).toEqual([tenantId]);
        const rows = await legacyRows(client);
        expect(rows.workspace).toBe(LEGACY_TENANT_ID);
        expect(rows.tenant).toBeDefined();
        const workspaces = await client.query("SELECT count(*)::int AS n FROM optio.workspaces");
        expect(workspaces.rows[0].n).toBe(2);
      } finally {
        await client.end();
      }
    });
  });
});

describe.skipIf(!databaseUrl)("Drizzle catalog API store through withTenant", () => {
  it("registers, finds, rolls back a conflicting register and pings", async () => {
    await withScratchDatabase(async (url) => {
      await runDrizzleMigrations(url);
      const pool = new pg.Pool({ connectionString: url });
      try {
        const db = createDb(pool, { tenantId: LEGACY_TENANT_ID });
        const store = createDrizzleOptioApiStore(db);
        const input = {
          email: "ops@example.com",
          passwordHash: "x",
          tenantName: "Acme",
          tenantSlug: "acme",
          workspace: { name: "Factory", slug: "factory" },
        };
        const created = await store.registerBootstrap(input);
        expect((await store.findTenantBySlug("acme"))?.id).toBe(created.tenant.id);
        await expect(
          store.registerBootstrap({ ...input, email: "other@example.com" }),
        ).rejects.toBeInstanceOf(StoreConflictError);
        const users = await pool.query("SELECT count(*)::int AS n FROM optio.users");
        expect(users.rows[0].n).toBe(1);
        expect(await db.ping()).toBe(true);
      } finally {
        await pool.end();
      }
    });
  });
});
