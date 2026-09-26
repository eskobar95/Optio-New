import { SessionConcurrencyConfigSchema, type SessionConcurrencyConfig } from "./config.js";
import {
  noopSessionTelemetry,
  SESSION_QUEUE_DEPTH_METRIC,
  SESSION_QUEUE_SPAN,
  type SessionTelemetry,
} from "./telemetry.js";
import {
  assertSafeId,
  isCodingProvider,
  SessionGateError,
  type CodingProvider,
  type ProviderConcurrencySnapshot,
  type SessionAcquireRequest,
  type SessionAcquireResult,
  type SessionConcurrencySnapshot,
  type SessionGate,
  type SessionLease,
  type SessionQueueOutcome,
  type SessionQueueTicket,
  type SessionRejectionReason,
  type SessionWorkspacePort,
} from "./types.js";
import { createPathWorkspacePort } from "./workspace.js";

interface NormalizedRequest {
  sessionId: string;
  taskId: string;
  provider: CodingProvider;
  enqueuedAt: number;
}

interface Waiter {
  request: NormalizedRequest;
  cancelled: boolean;
  settled: boolean;
  resolve: (lease: SessionLease) => void;
  reject: (err: Error) => void;
}

export interface CreateSessionGateOptions {
  config: SessionConcurrencyConfig;
  /** Defaults to a path claim under `config.worktreeRoot`. Pass a worktree-manager port to plug in SPEC §7. */
  workspace?: SessionWorkspacePort;
  /** Defaults to a no-op. Inject `InMemorySessionTelemetry` in tests or an OTel adapter in production. */
  telemetry?: SessionTelemetry;
  now?: () => number;
}

function compareRequests(a: NormalizedRequest, b: NormalizedRequest): number {
  if (a.enqueuedAt !== b.enqueuedAt) return a.enqueuedAt - b.enqueuedAt;
  if (a.sessionId < b.sessionId) return -1;
  if (a.sessionId > b.sessionId) return 1;
  return 0;
}

/**
 * Per-provider semaphore for coding-agent sessions.
 * Slot count is reserved before any await so two acquires cannot share one cap slot.
 * Fairness: the oldest `enqueuedAt` for that provider is granted when a slot frees.
 * A cap of 0 rejects immediately (no silent hang).
 */
export function createSessionGate(options: CreateSessionGateOptions): SessionGate {
  const config = SessionConcurrencyConfigSchema.parse(options.config);
  const workspace = options.workspace ?? createPathWorkspacePort(config.worktreeRoot);
  const telemetry = options.telemetry ?? noopSessionTelemetry;
  const now = options.now ?? Date.now;

  const leases = new Map<string, SessionLease>();
  const reserved = new Map<CodingProvider, Set<string>>();
  const waiters: Waiter[] = [];
  const taskOwner = new Map<string, string>();
  const promoting = new Set<CodingProvider>();

  function capOf(provider: CodingProvider): number {
    return provider === "cursor" ? config.cursor : config.codex;
  }

  function reserve(provider: CodingProvider, sessionId: string): void {
    let bucket = reserved.get(provider);
    if (!bucket) {
      bucket = new Set();
      reserved.set(provider, bucket);
    }
    bucket.add(sessionId);
  }

  function unreserve(provider: CodingProvider, sessionId: string): void {
    reserved.get(provider)?.delete(sessionId);
  }

  function activeCount(provider: CodingProvider): number {
    let n = reserved.get(provider)?.size ?? 0;
    for (const lease of leases.values()) {
      if (lease.provider === provider) n += 1;
    }
    return n;
  }

  function queueDepth(provider: CodingProvider): number {
    return waiters.filter(
      (waiter) => waiter.request.provider === provider && !waiter.cancelled && !waiter.settled,
    ).length;
  }

  function clearTask(request: NormalizedRequest): void {
    if (taskOwner.get(request.taskId) === request.sessionId) {
      taskOwner.delete(request.taskId);
    }
  }

  function observe(
    outcome: SessionQueueOutcome,
    request: NormalizedRequest,
    worktreeId: string,
    reason?: SessionRejectionReason,
  ): void {
    const queue_depth = queueDepth(request.provider);
    const active = activeCount(request.provider);
    const cap = capOf(request.provider);
    telemetry.emitSpan({
      name: SESSION_QUEUE_SPAN,
      task_id: request.taskId,
      worktree_id: worktreeId,
      attributes: {
        provider: request.provider,
        queue_depth,
        active,
        cap,
        outcome,
        ...(reason ? { reason } : {}),
      },
    });
    telemetry.recordQueueDepth({
      name: SESSION_QUEUE_DEPTH_METRIC,
      value: queue_depth,
      attributes: {
        provider: request.provider,
        task_id: request.taskId,
        worktree_id: worktreeId,
        active,
        cap,
      },
    });
  }

  function normalize(request: SessionAcquireRequest): NormalizedRequest {
    if (!isCodingProvider(request.provider)) {
      throw new SessionGateError("invalid_request", "provider must be cursor or codex");
    }
    assertSafeId(request.sessionId, "sessionId");
    assertSafeId(request.taskId, "taskId");
    const enqueuedAt = request.enqueuedAt ?? now();
    if (!Number.isFinite(enqueuedAt)) {
      throw new SessionGateError("invalid_request", "enqueuedAt must be a finite number");
    }
    return {
      sessionId: request.sessionId,
      taskId: request.taskId,
      provider: request.provider,
      enqueuedAt,
    };
  }

  function knownSession(sessionId: string): boolean {
    if (leases.has(sessionId)) return true;
    for (const bucket of reserved.values()) {
      if (bucket.has(sessionId)) return true;
    }
    return waiters.some(
      (waiter) => waiter.request.sessionId === sessionId && !waiter.cancelled && !waiter.settled,
    );
  }

  function positionOf(sessionId: string, provider: CodingProvider): number {
    const ordered = waiters
      .filter(
        (waiter) => waiter.request.provider === provider && !waiter.cancelled && !waiter.settled,
      )
      .sort((a, b) => compareRequests(a.request, b.request));
    const index = ordered.findIndex((waiter) => waiter.request.sessionId === sessionId);
    return index < 0 ? 0 : index + 1;
  }

  async function grant(request: NormalizedRequest): Promise<SessionLease> {
    reserve(request.provider, request.sessionId);
    taskOwner.set(request.taskId, request.sessionId);
    try {
      const claimed = await workspace.claim({
        sessionId: request.sessionId,
        taskId: request.taskId,
      });
      const lease: SessionLease = {
        sessionId: request.sessionId,
        taskId: request.taskId,
        provider: request.provider,
        worktreeId: claimed.worktreeId,
        worktreePath: claimed.path,
        workspace: claimed,
        release: () => release(lease),
      };
      unreserve(request.provider, request.sessionId);
      leases.set(request.sessionId, lease);
      observe("granted", request, claimed.worktreeId);
      return lease;
    } catch (err) {
      unreserve(request.provider, request.sessionId);
      clearTask(request);
      throw err;
    }
  }

  function takeOldest(provider: CodingProvider): Waiter | undefined {
    let bestIndex = -1;
    for (let i = 0; i < waiters.length; i += 1) {
      const waiter = waiters[i];
      if (!waiter || waiter.cancelled || waiter.settled || waiter.request.provider !== provider) {
        continue;
      }
      if (bestIndex < 0) {
        bestIndex = i;
        continue;
      }
      const best = waiters[bestIndex];
      if (best && compareRequests(waiter.request, best.request) < 0) {
        bestIndex = i;
      }
    }
    if (bestIndex < 0) return undefined;
    const [waiter] = waiters.splice(bestIndex, 1);
    if (!waiter) return undefined;
    waiter.settled = true;
    return waiter;
  }

  async function promote(provider: CodingProvider): Promise<void> {
    if (promoting.has(provider)) return;
    promoting.add(provider);
    try {
      while (activeCount(provider) < capOf(provider)) {
        const waiter = takeOldest(provider);
        if (!waiter) return;
        try {
          const lease = await grant(waiter.request);
          waiter.resolve(lease);
        } catch (err) {
          clearTask(waiter.request);
          waiter.reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    } finally {
      promoting.delete(provider);
    }
  }

  function enqueue(request: NormalizedRequest): SessionQueueTicket {
    let resolveLease: (lease: SessionLease) => void = () => {};
    let rejectLease: (err: Error) => void = () => {};
    const granted = new Promise<SessionLease>((resolve, reject) => {
      resolveLease = resolve;
      rejectLease = reject;
    });
    granted.catch(() => {
      /* cancel/reject is observed by the caller via ticket.granted */
    });
    const waiter: Waiter = {
      request,
      cancelled: false,
      settled: false,
      resolve: resolveLease,
      reject: rejectLease,
    };
    waiters.push(waiter);
    taskOwner.set(request.taskId, request.sessionId);
    const ticket: SessionQueueTicket = {
      sessionId: request.sessionId,
      taskId: request.taskId,
      provider: request.provider,
      enqueuedAt: request.enqueuedAt,
      get position() {
        return positionOf(request.sessionId, request.provider);
      },
      granted,
      cancel() {
        cancel(waiter);
      },
    };
    return ticket;
  }

  function cancel(waiter: Waiter): void {
    if (waiter.settled || waiter.cancelled) return;
    waiter.cancelled = true;
    waiter.settled = true;
    const index = waiters.indexOf(waiter);
    if (index >= 0) waiters.splice(index, 1);
    clearTask(waiter.request);
    waiter.reject(
      new SessionGateError("cancelled", `session ${waiter.request.sessionId} left the queue`),
    );
    observe("cancelled", waiter.request, "");
  }

  async function release(lease: SessionLease): Promise<void> {
    const current = leases.get(lease.sessionId);
    if (!current || current.worktreeId !== lease.worktreeId) return;
    leases.delete(lease.sessionId);
    clearTask({
      sessionId: lease.sessionId,
      taskId: lease.taskId,
      provider: lease.provider,
      enqueuedAt: 0,
    });
    let releaseError: unknown;
    try {
      await workspace.release(current.workspace);
    } catch (err) {
      releaseError = err;
    }
    observe(
      "released",
      {
        sessionId: lease.sessionId,
        taskId: lease.taskId,
        provider: lease.provider,
        enqueuedAt: 0,
      },
      "",
    );
    await promote(lease.provider);
    if (releaseError) throw releaseError;
  }

  function rejectResult(
    request: NormalizedRequest,
    reason: SessionRejectionReason,
  ): SessionAcquireResult {
    observe("rejected", request, "", reason);
    const queueDepthNow = queueDepth(request.provider);
    if (reason === "concurrency_cap") {
      return {
        status: "rejected",
        reason,
        provider: request.provider,
        queueDepth: queueDepthNow,
        codingAgentStatus: "rate_limited",
      };
    }
    return {
      status: "rejected",
      reason,
      provider: request.provider,
      queueDepth: queueDepthNow,
    };
  }

  function snapshotProvider(provider: CodingProvider): ProviderConcurrencySnapshot {
    return {
      provider,
      cap: capOf(provider),
      active: activeCount(provider),
      queueDepth: queueDepth(provider),
    };
  }

  return {
    async acquire(request: SessionAcquireRequest): Promise<SessionAcquireResult> {
      const normalized = normalize(request);
      if (knownSession(normalized.sessionId)) {
        throw new SessionGateError(
          "duplicate_session",
          `session ${normalized.sessionId} is already active or queued`,
        );
      }
      if (taskOwner.has(normalized.taskId)) {
        return rejectResult(normalized, "workspace_busy");
      }
      const cap = capOf(normalized.provider);
      const active = activeCount(normalized.provider);
      if (cap <= 0 || (active >= cap && config.overflow === "reject")) {
        return rejectResult(normalized, "concurrency_cap");
      }
      // At cap, or someone is already waiting: do not grant ahead of an older task.
      // `queueDepth > 0` while a slot looks free happens across `workspace.release`.
      if (active >= cap || queueDepth(normalized.provider) > 0) {
        const ticket = enqueue(normalized);
        observe("queued", normalized, "");
        await promote(normalized.provider);
        const grantedNow = leases.get(normalized.sessionId);
        if (grantedNow) {
          return { status: "granted", lease: grantedNow };
        }
        return { status: "queued", ticket };
      }
      try {
        const lease = await grant(normalized);
        return { status: "granted", lease };
      } catch (err) {
        if (err instanceof SessionGateError && err.code === "workspace_busy") {
          return rejectResult(normalized, "workspace_busy");
        }
        throw err;
      }
    },

    release,

    snapshot(): SessionConcurrencySnapshot {
      return {
        cursor: snapshotProvider("cursor"),
        codex: snapshotProvider("codex"),
      };
    },
  };
}
