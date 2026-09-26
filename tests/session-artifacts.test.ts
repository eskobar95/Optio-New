import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  InMemorySessionArtifactStore,
  InMemoryStepCursorStore,
  buildSessionArtifact,
  createAgentStageHandler,
  createIntakeServer,
  createSqlSessionArtifactStore,
  dumpSessionArtifactTrail,
  executeDumpCli,
  loadSessionArtifactsDdl,
  processStageJob,
  readArtifactLimits,
  runPipeline,
  type ArtifactSql,
  type SessionArtifact,
  type StageStepHandler,
} from "../src/index.js";

const identity = { taskId: "t-1", sessionId: "s-1" };
const limits = { retentionDays: 14, maxBytes: 16 * 1024, maxRows: 2000 };

function artifact(
  overrides: Partial<SessionArtifact> & Pick<SessionArtifact, "stage">,
): SessionArtifact {
  return {
    taskId: identity.taskId,
    sessionId: identity.sessionId,
    outcome: "completed",
    body: `# ${overrides.stage}`,
    planText: null,
    prUrl: null,
    errorMessage: null,
    updatedAt: "2026-09-26T00:00:00.000Z",
    ...overrides,
  };
}

describe("session artifact trail", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
    );
  });

  it("stores plan text, the pull request link, and the last error", async () => {
    const store = new InMemorySessionArtifactStore();
    const cursors = new InMemoryStepCursorStore();
    let crash = true;
    const handler: StageStepHandler = {
      async run(ctx) {
        if (ctx.stage === "plan" && ctx.step === "invoke_planner") {
          return { summary: "cut the branch" };
        }
        if (ctx.step === "open_pr") return { prUrl: "https://github.com/acme/repo/pull/7" };
        if (crash && ctx.stage === "implement" && ctx.step === "record_diff") {
          crash = false;
          throw new Error("implement blew up");
        }
        return undefined;
      },
    };

    await processStageJob(
      { ...identity, stage: "plan", title: "Ship graph", description: "details" },
      { cursors, artifacts: store, artifactLimits: limits, handler },
    );
    await expect(
      processStageJob(
        { ...identity, stage: "implement" },
        { cursors, artifacts: store, artifactLimits: limits, handler },
      ),
    ).rejects.toThrow(/implement blew up/);

    const failed = await dumpSessionArtifactTrail(store, identity.taskId, identity.sessionId);
    expect(failed.planText).toContain("Ship graph");
    expect(failed.planText).toContain("details");
    expect(failed.planText).toContain("cut the branch");
    expect(failed.prUrl).toBeNull();
    expect(failed.lastError).toBe("implement blew up");
    expect(failed.artifacts.map((row) => `${row.stage}:${row.outcome}`)).toEqual([
      "plan:completed",
      "implement:failed",
    ]);

    await runPipeline(identity, { cursors, artifacts: store, artifactLimits: limits, handler });
    const done = await dumpSessionArtifactTrail(store, identity.taskId, identity.sessionId);
    expect(done.planText).toContain("Ship graph");
    expect(done.prUrl).toBe("https://github.com/acme/repo/pull/7");
    expect(done.lastError).toBeNull();
    expect(done.artifacts.find((row) => row.stage === "ready")?.body).toContain(
      "pr: https://github.com/acme/repo/pull/7",
    );
    expect(done.artifacts).toHaveLength(5);
  });

  it("keeps the planner summary from the agent loop", async () => {
    const store = new InMemorySessionArtifactStore();
    await processStageJob(
      { ...identity, stage: "plan", title: "Ship graph" },
      {
        cursors: new InMemoryStepCursorStore(),
        artifacts: store,
        artifactLimits: limits,
        handler: createAgentStageHandler({
          async complete() {
            return { text: "cut the branch" };
          },
        }),
      },
    );
    const trail = await dumpSessionArtifactTrail(store, identity.taskId, identity.sessionId);
    expect(trail.planText).toContain("cut the branch");
  });

  it("caps text and prunes by age and row count", async () => {
    const built = buildSessionArtifact({
      ...artifact({ stage: "plan", planText: "x".repeat(500) }),
      limits: { retentionDays: 14, maxBytes: 64, maxRows: 2000 },
    });
    expect(Buffer.byteLength(built.planText ?? "")).toBeLessThanOrEqual(64);
    expect(built.planText).toContain("[truncated]");
    expect(Buffer.byteLength(built.body)).toBeLessThanOrEqual(64);

    const store = new InMemorySessionArtifactStore();
    await store.upsert(artifact({ stage: "plan", updatedAt: "2020-01-01T00:00:00.000Z" }));
    await store.upsert(artifact({ stage: "implement", updatedAt: "2026-01-01T00:00:00.000Z" }));
    await store.upsert(artifact({ stage: "review", updatedAt: "2026-06-01T00:00:00.000Z" }));
    expect(await store.prune("2021-01-01T00:00:00.000Z", 2000)).toBe(1);
    expect(await store.prune("1970-01-01T00:00:00.000Z", 1)).toBe(1);
    await expect(store.list(identity.taskId, identity.sessionId)).resolves.toEqual([
      expect.objectContaining({ stage: "review" }),
    ]);
  });

  it("round-trips through the SQL artifact store", async () => {
    const ddl = loadSessionArtifactsDdl();
    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS session_artifacts");
    expect(ddl).toContain("PRIMARY KEY (task_id, session_id, stage)");
    expect(ddl).toContain("session_artifacts_updated_at_idx");

    const rows = new Map<string, Record<string, unknown>>();
    const db: ArtifactSql = {
      async query(sql, params = []) {
        if (sql.startsWith("INSERT")) {
          const [
            taskId,
            sessionId,
            stage,
            outcome,
            body,
            planText,
            prUrl,
            errorMessage,
            updatedAt,
          ] = params;
          rows.set(`${String(taskId)}|${String(sessionId)}|${String(stage)}`, {
            task_id: taskId,
            session_id: sessionId,
            stage,
            outcome,
            body,
            plan_text: planText,
            pr_url: prUrl,
            error_message: errorMessage,
            updated_at: updatedAt,
          });
          return { rows: [] };
        }
        if (sql.startsWith("SELECT")) {
          const [taskId, sessionId] = params;
          return {
            rows: [...rows.values()].filter(
              (row) => row.task_id === taskId && row.session_id === sessionId,
            ),
          };
        }
        if (sql.includes("updated_at <")) {
          return { rows: [] };
        }
        if (sql.includes("OFFSET")) {
          return { rows: [] };
        }
        throw new Error(`unexpected sql: ${sql}`);
      },
    };

    const store = createSqlSessionArtifactStore(db);
    await store.upsert(artifact({ stage: "plan", planText: "Ship graph" }));
    await store.upsert(
      artifact({
        stage: "ready",
        prUrl: "https://github.com/acme/repo/pull/7",
      }),
    );
    const trail = await dumpSessionArtifactTrail(store, identity.taskId, identity.sessionId);
    expect(trail.planText).toBe("Ship graph");
    expect(trail.prUrl).toBe("https://github.com/acme/repo/pull/7");
  });

  it("serves GET /tasks/:taskId/artifacts and a CLI dump", async () => {
    const store = new InMemorySessionArtifactStore();
    await store.upsert(artifact({ stage: "plan", planText: "Ship graph" }));
    const server = createIntakeServer({
      enqueuer: { async add() {} },
      readArtifactTrail: (taskId, sessionId) => dumpSessionArtifactTrail(store, taskId, sessionId),
    });
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;

    const missing = await fetch(`${base}/tasks/t-1/artifacts`);
    expect(missing.status).toBe(200);
    await expect(missing.json()).resolves.toMatchObject({
      taskId: "t-1",
      sessionId: "t-1",
      planText: null,
    });

    const found = await fetch(`${base}/tasks/t-1/artifacts?sessionId=s-1`);
    expect(found.status).toBe(200);
    await expect(found.json()).resolves.toMatchObject({
      taskId: "t-1",
      sessionId: "s-1",
      planText: "Ship graph",
      prUrl: null,
      lastError: null,
    });

    const posted = await fetch(`${base}/tasks/t-1/artifacts`, { method: "POST" });
    expect(posted.status).toBe(405);

    const hidden = createIntakeServer({ enqueuer: { async add() {} } });
    servers.push(hidden);
    await new Promise<void>((resolve) => {
      hidden.listen(0, "127.0.0.1", () => resolve());
    });
    const hiddenAddress = hidden.address() as AddressInfo;
    const unavailable = await fetch(`http://127.0.0.1:${hiddenAddress.port}/tasks/t-1/artifacts`);
    expect(unavailable.status).toBe(404);

    let stdout = "";
    const code = await executeDumpCli({
      argv: ["--task", "t-1", "--session", "s-1"],
      env: {},
      stdout: (line) => {
        stdout = line;
      },
      stderr: () => undefined,
      store,
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ planText: "Ship graph" });

    let usage = "";
    expect(
      await executeDumpCli({
        argv: [],
        env: {},
        stdout: () => undefined,
        stderr: (line) => {
          usage = line;
        },
      }),
    ).toBe(2);
    expect(usage).toContain("--task");
  });

  it("documents CX33 retention and the dump command", () => {
    expect(readArtifactLimits({})).toEqual({
      retentionDays: 14,
      maxBytes: 16 * 1024,
      maxRows: 2000,
    });
    expect(readArtifactLimits({ OPTIO_NEW_ARTIFACT_RETENTION_DAYS: "0" }).retentionDays).toBe(1);
    expect(readArtifactLimits({ OPTIO_NEW_ARTIFACT_RETENTION_DAYS: "30" }).retentionDays).toBe(30);
    const doc = readFileSync("docs/ops/session-artifacts.md", "utf8");
    expect(doc).toContain("CX33");
    expect(doc).toContain("80 GB");
    expect(doc).toContain("14");
    expect(doc).toContain("GET /tasks/");
    const script = readFileSync("scripts/dump-session-artifacts.sh", "utf8");
    expect(script).toContain("/tasks/");
    expect(script).toContain("artifacts");
    expect(script).not.toContain("ghp_");
  });
});
