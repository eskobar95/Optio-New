import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertNoPlaintextSecrets,
  ApiHttpError,
  createOptioApiServer,
  hashPassword,
  MemoryOptioApiStore,
  resolveOptioApiListen,
  verifyPassword,
} from "../src/api/index.js";

const SESSION_SECRET = "test-session-secret-16chars";

async function withServer(
  store: MemoryOptioApiStore,
  run: (base: string) => Promise<void>,
): Promise<void> {
  const server: Server = createOptioApiServer({ store, sessionSecret: SESSION_SECRET });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a TCP port");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function register(
  base: string,
  overrides: Record<string, unknown> = {},
): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const res = await fetch(`${base}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "ops@example.com",
      password: "correct-horse",
      tenantName: "Acme",
      tenantSlug: "acme",
      workspaceName: "Software factory",
      workspaceSlug: "software-factory",
      ...overrides,
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("optio catalog API (ENG-23)", () => {
  const stores: MemoryOptioApiStore[] = [];
  afterEach(() => {
    stores.length = 0;
  });

  it("resolveOptioApiListen defaults to 3210", () => {
    expect(resolveOptioApiListen({})).toEqual({ host: "127.0.0.1", port: 3210 });
    expect(
      resolveOptioApiListen({ OPTIO_NEW_API_PORT: "bad", OPTIO_NEW_API_HOST: "0.0.0.0" }),
    ).toEqual({
      host: "0.0.0.0",
      port: 3210,
    });
  });

  it("hashes and verifies passwords with scrypt", async () => {
    const hash = await hashPassword("correct-horse");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct-horse", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  it("rejects plaintext secret keys in connection payloads", () => {
    expect(() => assertNoPlaintextSecrets({ token: "ghp_x" })).toThrow(ApiHttpError);
    expect(() => assertNoPlaintextSecrets({ config: { apiKey: "x" } })).toThrow(ApiHttpError);
    expect(() =>
      assertNoPlaintextSecrets({ config: { baseUrl: "https://api.github.com" } }),
    ).not.toThrow();
  });

  it("register → login → list/switch memberships → CRUD connections → list agents/skills", async () => {
    const store = new MemoryOptioApiStore();
    stores.push(store);

    await withServer(store, async (base) => {
      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ ok: true, service: "optio-api" });

      const created = await register(base);
      expect(created.status).toBe(201);
      const token = created.body.token as string;
      expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      const workspace = created.body.workspace as { id: string };
      expect(workspace.id).toBeTruthy();
      expect(created.body.user).toMatchObject({ email: "ops@example.com" });
      expect((created.body.user as { passwordHash?: string }).passwordHash).toBeUndefined();

      const badLogin = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "ops@example.com",
          password: "wrong-password",
          tenantSlug: "acme",
        }),
      });
      expect(badLogin.status).toBe(401);

      const login = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "ops@example.com",
          password: "correct-horse",
          tenantSlug: "acme",
        }),
      });
      expect(login.status).toBe(200);
      const loginBody = (await login.json()) as { token: string; memberships: unknown[] };
      expect(loginBody.memberships).toHaveLength(1);

      const me = await fetch(`${base}/auth/me`, {
        headers: { authorization: `Bearer ${loginBody.token}` },
      });
      expect(me.status).toBe(200);

      const secondWs = await fetch(`${base}/workspaces`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Marketing", slug: "marketing-factory" }),
      });
      expect(secondWs.status).toBe(201);
      const secondBody = (await secondWs.json()) as {
        token: string;
        workspace: { id: string };
      };

      const memberships = await fetch(`${base}/memberships`, {
        headers: { authorization: `Bearer ${secondBody.token}` },
      });
      expect(memberships.status).toBe(200);
      const membershipBody = (await memberships.json()) as {
        memberships: unknown[];
        activeWorkspaceId: string;
      };
      expect(membershipBody.memberships).toHaveLength(2);

      const switched = await fetch(`${base}/memberships/switch`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${secondBody.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ workspaceId: workspace.id }),
      });
      expect(switched.status).toBe(200);
      const switchBody = (await switched.json()) as { token: string; activeWorkspaceId: string };
      expect(switchBody.activeWorkspaceId).toBe(workspace.id);

      const auth = switchBody.token;

      const rejectSecret = await fetch(`${base}/workspaces/${workspace.id}/connections`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${auth}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          kind: "github",
          name: "main",
          infisicalSecretPath: "/workspaces/software-factory/github",
          config: { token: "ghp_should_never_land" },
        }),
      });
      expect(rejectSecret.status).toBe(400);
      expect(await rejectSecret.json()).toMatchObject({ error: "plaintext_secret_rejected" });

      const createGh = await fetch(`${base}/workspaces/${workspace.id}/connections`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${auth}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          kind: "github",
          name: "main",
          infisicalSecretPath: "/workspaces/software-factory/github",
          config: { owner: "acme", repo: "app" },
        }),
      });
      expect(createGh.status).toBe(201);
      const gh = (await createGh.json()) as {
        connection: { id: string; infisicalSecretPath: string };
      };
      expect(gh.connection.infisicalSecretPath).toBe("/workspaces/software-factory/github");

      const createLin = await fetch(`${base}/workspaces/${workspace.id}/connections`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${auth}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          kind: "linear",
          name: "eng",
          infisicalSecretPath: "/workspaces/software-factory/linear",
          config: { teamKey: "ENG" },
        }),
      });
      expect(createLin.status).toBe(201);

      const listed = await fetch(`${base}/workspaces/${workspace.id}/connections`, {
        headers: { authorization: `Bearer ${auth}` },
      });
      expect(listed.status).toBe(200);
      const listedBody = (await listed.json()) as { connections: unknown[] };
      expect(listedBody.connections).toHaveLength(2);

      const patched = await fetch(
        `${base}/workspaces/${workspace.id}/connections/${gh.connection.id}`,
        {
          method: "PATCH",
          headers: {
            authorization: `Bearer ${auth}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ enabled: false }),
        },
      );
      expect(patched.status).toBe(200);
      expect(await patched.json()).toMatchObject({
        connection: { enabled: false },
      });

      store.seedAgent({
        id: randomUUID(),
        workspaceId: workspace.id,
        name: "planner",
        kind: "planner",
        model: "test-model",
        enabled: true,
      });
      store.seedSkill({
        id: randomUUID(),
        workspaceId: workspace.id,
        name: "tdd",
        slug: "tdd",
        description: "red-green",
        enabled: true,
      });

      const agents = await fetch(`${base}/workspaces/${workspace.id}/agents`, {
        headers: { authorization: `Bearer ${auth}` },
      });
      expect(agents.status).toBe(200);
      expect(await agents.json()).toMatchObject({
        agents: [{ name: "planner", kind: "planner" }],
      });

      const skills = await fetch(`${base}/workspaces/${workspace.id}/skills`, {
        headers: { authorization: `Bearer ${auth}` },
      });
      expect(skills.status).toBe(200);
      expect(await skills.json()).toMatchObject({
        skills: [{ slug: "tdd", description: "red-green" }],
      });

      const deleted = await fetch(
        `${base}/workspaces/${workspace.id}/connections/${gh.connection.id}`,
        {
          method: "DELETE",
          headers: { authorization: `Bearer ${auth}` },
        },
      );
      expect(deleted.status).toBe(200);

      const afterDelete = await fetch(`${base}/workspaces/${workspace.id}/connections`, {
        headers: { authorization: `Bearer ${auth}` },
      });
      const afterBody = (await afterDelete.json()) as { connections: unknown[] };
      expect(afterBody.connections).toHaveLength(1);
    });
  });

  it("requires auth for membership and connection routes", async () => {
    const store = new MemoryOptioApiStore();
    await withServer(store, async (base) => {
      const res = await fetch(`${base}/memberships`);
      expect(res.status).toBe(401);
    });
  });
});
