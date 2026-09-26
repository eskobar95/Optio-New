import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPathWorkspacePort,
  createSessionGate,
  InMemorySessionTelemetry,
  loadSessionConcurrencyConfig,
  readSessionFile,
  SessionGateError,
  workspacePortFromWorktreeManager,
  WorktreeAlreadyExistsError,
  writeSessionFile,
  type SessionAcquireResult,
  type SessionConcurrencyConfig,
  type SessionLease,
  type SessionWorkspacePort,
} from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tmpRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "optio-sessions-"));
  roots.push(root);
  return root;
}

function config(
  root: string,
  overrides: Partial<SessionConcurrencyConfig> = {},
): SessionConcurrencyConfig {
  return {
    cursor: 1,
    codex: 1,
    overflow: "queue",
    worktreeRoot: root,
    ...overrides,
  };
}

function granted(result: SessionAcquireResult): SessionLease {
  expect(result.status).toBe("granted");
  if (result.status !== "granted") {
    throw new Error(`expected granted, got ${result.status}`);
  }
  return result.lease;
}

describe("session concurrency config", () => {
  it("reads max Cursor and Codex caps and overflow from the environment", () => {
    const loaded = loadSessionConcurrencyConfig({
      OPTIO_NEW_CURSOR_MAX_CONCURRENCY: "4",
      OPTIO_NEW_CODEX_MAX_CONCURRENCY: "2",
      OPTIO_NEW_SESSION_OVERFLOW: "reject",
      OPTIO_NEW_WORKTREE_ROOT: "/var/lib/optio-new/worktrees",
    });
    expect(loaded).toEqual({
      cursor: 4,
      codex: 2,
      overflow: "reject",
      worktreeRoot: "/var/lib/optio-new/worktrees",
    });
  });

  it("defaults to one slot per provider and fails closed on invalid caps", () => {
    expect(loadSessionConcurrencyConfig({})).toEqual({
      cursor: 1,
      codex: 1,
      overflow: "queue",
      worktreeRoot: "/var/lib/optio-new/worktrees",
    });
    expect(() => loadSessionConcurrencyConfig({ OPTIO_NEW_CURSOR_MAX_CONCURRENCY: "-1" })).toThrow(
      SessionGateError,
    );
    expect(() => loadSessionConcurrencyConfig({ OPTIO_NEW_SESSION_OVERFLOW: "drop" })).toThrow(
      /queue or reject/,
    );
  });
});

describe("provider semaphores", () => {
  it("rejects overflow when Cursor or Codex is at its configured cap", async () => {
    const root = await tmpRoot();
    const telemetry = new InMemorySessionTelemetry();
    const gate = createSessionGate({
      config: config(root, { cursor: 2, codex: 3, overflow: "reject" }),
      telemetry,
    });

    const cursorLeases = [
      granted(
        await gate.acquire({
          sessionId: "c1",
          taskId: "task-c1",
          provider: "cursor",
          enqueuedAt: 1,
        }),
      ),
      granted(
        await gate.acquire({
          sessionId: "c2",
          taskId: "task-c2",
          provider: "cursor",
          enqueuedAt: 2,
        }),
      ),
    ];
    const cursorOverflow = await gate.acquire({
      sessionId: "c3",
      taskId: "task-c3",
      provider: "cursor",
      enqueuedAt: 3,
    });
    expect(cursorOverflow).toEqual({
      status: "rejected",
      reason: "concurrency_cap",
      provider: "cursor",
      queueDepth: 0,
      codingAgentStatus: "rate_limited",
    });

    for (let n = 1; n <= 3; n += 1) {
      granted(
        await gate.acquire({
          sessionId: `x${n}`,
          taskId: `task-x${n}`,
          provider: "codex",
          enqueuedAt: n,
        }),
      );
    }
    const codexOverflow = await gate.acquire({
      sessionId: "x4",
      taskId: "task-x4",
      provider: "codex",
      enqueuedAt: 4,
    });
    expect(codexOverflow).toMatchObject({
      status: "rejected",
      reason: "concurrency_cap",
      provider: "codex",
      queueDepth: 0,
      codingAgentStatus: "rate_limited",
    });

    expect(gate.snapshot()).toMatchObject({
      cursor: { cap: 2, active: 2, queueDepth: 0 },
      codex: { cap: 3, active: 3, queueDepth: 0 },
    });
    await cursorLeases[0]?.release();
    const retried = granted(
      await gate.acquire({ sessionId: "c3", taskId: "task-c3", provider: "cursor", enqueuedAt: 5 }),
    );
    expect(retried.worktreePath).not.toBe(cursorLeases[1]?.worktreePath);
  });

  it("does not let a full Cursor cap block Codex", async () => {
    const root = await tmpRoot();
    const gate = createSessionGate({
      config: config(root, { cursor: 1, codex: 1, overflow: "reject" }),
    });
    granted(
      await gate.acquire({ sessionId: "c1", taskId: "task-c1", provider: "cursor", enqueuedAt: 1 }),
    );
    const codex = granted(
      await gate.acquire({ sessionId: "x1", taskId: "task-x1", provider: "codex", enqueuedAt: 1 }),
    );
    expect(codex.provider).toBe("codex");
    expect(codex.worktreePath).not.toBe("");
  });

  it("rejects immediately when a provider cap is zero", async () => {
    const root = await tmpRoot();
    const gate = createSessionGate({
      config: config(root, { cursor: 0, overflow: "queue" }),
    });
    const result = await gate.acquire({
      sessionId: "c1",
      taskId: "task-c1",
      provider: "cursor",
      enqueuedAt: 1,
    });
    expect(result).toMatchObject({ status: "rejected", reason: "concurrency_cap", queueDepth: 0 });
  });

  it("queues overflow and grants the older task first", async () => {
    const root = await tmpRoot();
    const telemetry = new InMemorySessionTelemetry();
    const gate = createSessionGate({
      config: config(root, { cursor: 1, overflow: "queue" }),
      telemetry,
    });
    const holder = granted(
      await gate.acquire({ sessionId: "s1", taskId: "task-s1", provider: "cursor", enqueuedAt: 1 }),
    );
    const newer = await gate.acquire({
      sessionId: "s2",
      taskId: "task-s2",
      provider: "cursor",
      enqueuedAt: 300,
    });
    const older = await gate.acquire({
      sessionId: "s3",
      taskId: "task-s3",
      provider: "cursor",
      enqueuedAt: 200,
    });
    expect(newer.status).toBe("queued");
    expect(older.status).toBe("queued");
    if (newer.status !== "queued" || older.status !== "queued") return;
    expect(older.ticket.position).toBe(1);
    expect(newer.ticket.position).toBe(2);
    expect(gate.snapshot().cursor).toMatchObject({ active: 1, queueDepth: 2, cap: 1 });

    const queuedSpan = telemetry.spans.find(
      (span) => span.task_id === "task-s2" && span.attributes.outcome === "queued",
    );
    expect(queuedSpan).toMatchObject({
      name: "session.queue",
      task_id: "task-s2",
      worktree_id: "",
      attributes: { provider: "cursor", queue_depth: 1, outcome: "queued", cap: 1 },
    });
    expect(
      telemetry.metrics.some(
        (metric) =>
          metric.name === "session.queue_depth" &&
          metric.value === 1 &&
          metric.attributes.provider === "cursor" &&
          metric.attributes.task_id === "task-s2" &&
          metric.attributes.worktree_id === "",
      ),
    ).toBe(true);

    await holder.release();
    const first = await older.ticket.granted;
    expect(first.sessionId).toBe("s3");
    expect(first.worktreeId).toBe("wt-task-s3");
    expect(gate.snapshot().cursor.queueDepth).toBe(1);
    const promoted = telemetry.spans.find(
      (span) => span.task_id === "task-s3" && span.attributes.outcome === "granted",
    );
    expect(promoted).toMatchObject({
      worktree_id: "wt-task-s3",
      attributes: { queue_depth: 1, outcome: "granted" },
    });

    const cancelled = newer.ticket.granted.then(
      () => "granted",
      (err: unknown) => (err instanceof SessionGateError ? err.code : "other"),
    );
    newer.ticket.cancel();
    await expect(cancelled).resolves.toBe("cancelled");
    expect(gate.snapshot().cursor.queueDepth).toBe(0);
    await first.release();
    expect(gate.snapshot().cursor.active).toBe(0);
  });

  it("does not hand a freed slot to a newer arrival ahead of a waiter", async () => {
    const root = await tmpRoot();
    const inner = createPathWorkspacePort(root);
    let markEntered: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let unblock: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const workspace: SessionWorkspacePort = {
      claim: (request) => inner.claim(request),
      async release(current) {
        markEntered();
        await blocked;
        await inner.release(current);
      },
    };
    const gate = createSessionGate({
      config: config(root, { cursor: 1, overflow: "queue" }),
      workspace,
    });
    const holder = granted(
      await gate.acquire({ sessionId: "s1", taskId: "task-s1", provider: "cursor", enqueuedAt: 1 }),
    );
    const waiting = await gate.acquire({
      sessionId: "s2",
      taskId: "task-s2",
      provider: "cursor",
      enqueuedAt: 10,
    });
    expect(waiting.status).toBe("queued");
    const releasing = holder.release();
    await entered;
    const arrival = await gate.acquire({
      sessionId: "s3",
      taskId: "task-s3",
      provider: "cursor",
      enqueuedAt: 50,
    });
    expect(arrival.status).toBe("queued");
    unblock();
    await releasing;
    if (waiting.status !== "queued") throw new Error("expected s2 to stay queued");
    await expect(waiting.ticket.granted).resolves.toMatchObject({ sessionId: "s2" });
    expect(gate.snapshot().cursor).toMatchObject({ active: 1, queueDepth: 1 });
  });

  it("lets only one of two parallel acquires take the last slot", async () => {
    const root = await tmpRoot();
    const gate = createSessionGate({
      config: config(root, { cursor: 1, overflow: "queue" }),
    });
    const [first, second] = await Promise.all([
      gate.acquire({ sessionId: "s1", taskId: "task-s1", provider: "cursor", enqueuedAt: 1 }),
      gate.acquire({ sessionId: "s2", taskId: "task-s2", provider: "cursor", enqueuedAt: 2 }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(["granted", "queued"]);
    expect(gate.snapshot().cursor).toMatchObject({ active: 1, queueDepth: 1 });
  });
});

describe("session workspace isolation", () => {
  it("keeps two sessions from overwriting each other's files", async () => {
    const root = await tmpRoot();
    const gate = createSessionGate({
      config: config(root, { cursor: 2, codex: 2, overflow: "reject" }),
    });
    const alpha = granted(
      await gate.acquire({ sessionId: "s1", taskId: "task-a", provider: "cursor", enqueuedAt: 1 }),
    );
    const beta = granted(
      await gate.acquire({ sessionId: "s2", taskId: "task-b", provider: "cursor", enqueuedAt: 2 }),
    );
    expect(alpha.worktreePath).not.toBe(beta.worktreePath);
    expect(alpha.worktreeId).toBe("wt-task-a");
    expect(beta.worktreeId).toBe("wt-task-b");

    await Promise.all([
      writeSessionFile(alpha.workspace, "marker.txt", "alpha"),
      writeSessionFile(beta.workspace, "marker.txt", "beta"),
    ]);
    expect(await readSessionFile(alpha.workspace, "marker.txt")).toBe("alpha");
    expect(await readSessionFile(beta.workspace, "marker.txt")).toBe("beta");

    await expect(
      writeSessionFile(alpha.workspace, `../${beta.worktreeId}/marker.txt`, "overwrite"),
    ).rejects.toMatchObject({ code: "workspace_escape" });
    expect(await readSessionFile(beta.workspace, "marker.txt")).toBe("beta");

    const sameTask = await gate.acquire({
      sessionId: "s3",
      taskId: "task-a",
      provider: "codex",
      enqueuedAt: 3,
    });
    expect(sameTask).toMatchObject({ status: "rejected", reason: "workspace_busy" });
    expect(await readSessionFile(alpha.workspace, "marker.txt")).toBe("alpha");
  });

  it("plugs into a worktree manager without reaping on release", async () => {
    const root = await tmpRoot();
    const reaped: string[] = [];
    const created: string[] = [];
    const manager = {
      async create(taskId: string) {
        if (created.includes(taskId)) throw new WorktreeAlreadyExistsError(taskId);
        const path = join(root, `wt-${taskId}`);
        await mkdir(path, { recursive: true });
        created.push(taskId);
        return { worktreeId: `wt-${taskId}`, path };
      },
      async reap(taskId: string) {
        reaped.push(taskId);
      },
    };
    const telemetry = new InMemorySessionTelemetry();
    const gate = createSessionGate({
      config: config(root, { cursor: 2, overflow: "reject" }),
      workspace: workspacePortFromWorktreeManager(manager),
      telemetry,
    });
    const alpha = granted(
      await gate.acquire({ sessionId: "s1", taskId: "task-a", provider: "cursor", enqueuedAt: 1 }),
    );
    const beta = granted(
      await gate.acquire({ sessionId: "s2", taskId: "task-b", provider: "cursor", enqueuedAt: 2 }),
    );
    expect(alpha.worktreePath).not.toBe(beta.worktreePath);
    await writeSessionFile(alpha.workspace, "marker.txt", "alpha");
    await writeSessionFile(beta.workspace, "marker.txt", "beta");
    expect(await readSessionFile(alpha.workspace, "marker.txt")).toBe("alpha");
    expect(await readSessionFile(beta.workspace, "marker.txt")).toBe("beta");

    const busy = await gate.acquire({
      sessionId: "s3",
      taskId: "task-a",
      provider: "cursor",
      enqueuedAt: 3,
    });
    expect(busy).toMatchObject({ status: "rejected", reason: "workspace_busy" });
    expect(created).toEqual(["task-a", "task-b"]);

    await alpha.release();
    await beta.release();
    expect(reaped).toEqual([]);
    expect(
      telemetry.spans.some(
        (span) => span.name === "session.queue" && span.worktree_id === "wt-task-a",
      ),
    ).toBe(true);
  });

  it("maps a manager duplicate create to workspace_busy", async () => {
    const port = workspacePortFromWorktreeManager({
      async create(taskId: string) {
        throw new WorktreeAlreadyExistsError(taskId);
      },
    });
    await expect(port.claim({ sessionId: "s1", taskId: "task-a" })).rejects.toMatchObject({
      code: "workspace_busy",
    });
  });
});
