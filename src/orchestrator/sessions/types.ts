/**
 * Parallel coding sessions (SPEC §13.5).
 * One semaphore per provider, one workspace claim per task.
 * Git worktree create/reap stays with the worktree manager (SPEC §7).
 */

export const CODING_PROVIDERS = ["cursor", "codex"] as const;

export type CodingProvider = (typeof CODING_PROVIDERS)[number];

export type SessionOverflow = "queue" | "reject";

export type SessionQueueOutcome = "granted" | "queued" | "rejected" | "released" | "cancelled";

export type SessionRejectionReason = "concurrency_cap" | "workspace_busy";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class SessionGateError extends Error {
  readonly code:
    "invalid_request" | "duplicate_session" | "workspace_busy" | "workspace_escape" | "cancelled";

  constructor(
    code:
      "invalid_request" | "duplicate_session" | "workspace_busy" | "workspace_escape" | "cancelled",
    message: string,
  ) {
    super(message);
    this.name = "SessionGateError";
    this.code = code;
  }
}

/** Thrown by a worktree manager when `create(taskId)` would reuse an existing tree. */
export class WorktreeAlreadyExistsError extends Error {
  readonly code = "worktree_exists" as const;

  constructor(readonly taskId: string) {
    super(`worktree already exists for task ${taskId}`);
    this.name = "WorktreeAlreadyExistsError";
  }
}

export function assertSafeId(id: string, label: string): void {
  if (!ID_PATTERN.test(id)) {
    throw new SessionGateError(
      "invalid_request",
      `${label} must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}`,
    );
  }
}

export function isCodingProvider(value: string): value is CodingProvider {
  return (CODING_PROVIDERS as readonly string[]).includes(value);
}

/** Exclusive cwd for one session. `path` is absolute and not shared. */
export interface SessionWorkspace {
  sessionId: string;
  taskId: string;
  worktreeId: string;
  path: string;
}

export interface SessionWorkspaceClaim {
  sessionId: string;
  taskId: string;
}

/**
 * Plug for the worktree manager (issue #6 / SPEC §7).
 * `release` drops the session claim only — it must not reap the git worktree.
 */
export interface SessionWorkspacePort {
  claim(request: SessionWorkspaceClaim): Promise<SessionWorkspace>;
  release(workspace: SessionWorkspace): Promise<void>;
}

/**
 * Minimal worktree-manager surface this gate can adapt.
 * `create` must return a path unique to `taskId` or throw `WorktreeAlreadyExistsError`.
 */
export interface WorktreeManagerLike {
  create(taskId: string): Promise<{ worktreeId: string; path: string }>;
}

export interface SessionAcquireRequest {
  sessionId: string;
  taskId: string;
  provider: CodingProvider;
  /** Unix epoch ms. Older values are granted first when a slot frees. */
  enqueuedAt?: number;
}

export interface SessionLease {
  sessionId: string;
  taskId: string;
  provider: CodingProvider;
  worktreeId: string;
  worktreePath: string;
  workspace: SessionWorkspace;
  release(): Promise<void>;
}

export interface SessionQueueTicket {
  sessionId: string;
  taskId: string;
  provider: CodingProvider;
  /** 1-based position among waiters for this provider. Older tasks sit closer to 1. */
  readonly position: number;
  enqueuedAt: number;
  /** Resolves when a slot is granted. Rejects with `SessionGateError` code `cancelled` on `cancel()`. */
  granted: Promise<SessionLease>;
  cancel(): void;
}

export type SessionAcquireResult =
  | { status: "granted"; lease: SessionLease }
  | { status: "queued"; ticket: SessionQueueTicket }
  | {
      status: "rejected";
      reason: "concurrency_cap";
      provider: CodingProvider;
      queueDepth: number;
      /** SPEC §13.5: exhausted provider slots surface as `rate_limited`, not a hang. */
      codingAgentStatus: "rate_limited";
    }
  | {
      status: "rejected";
      reason: "workspace_busy";
      provider: CodingProvider;
      queueDepth: number;
    };

export interface ProviderConcurrencySnapshot {
  provider: CodingProvider;
  cap: number;
  /** Slots in use (granted, plus a claim still being created). */
  active: number;
  queueDepth: number;
}

export interface SessionConcurrencySnapshot {
  cursor: ProviderConcurrencySnapshot;
  codex: ProviderConcurrencySnapshot;
}

export interface SessionGate {
  acquire(request: SessionAcquireRequest): Promise<SessionAcquireResult>;
  release(lease: SessionLease): Promise<void>;
  snapshot(): SessionConcurrencySnapshot;
}
