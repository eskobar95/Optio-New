/**
 * Linear board contract for Optio.
 * Pure decisions: who may move, when CI blocks Review, and when to escalate.
 * Column create/rename is not performed. See boardSetupPlan.
 */

export const CI_FAIL_ESCALATE_ENV = "LINEAR_WORKFLOW_CI_FAIL_ESCALATE_AFTER";
export const DEFAULT_CI_FAIL_ESCALATE_AFTER = 3;
export const LINEAR_PULL_REQUEST_BASE = "main";

export const LINEAR_STATUS = {
  triage: "Triage",
  backlog: "Backlog",
  todo: "Todo",
  inProgress: "In Progress",
  review: "Review",
  merge: "Merge",
  done: "Done",
  canceled: "Canceled",
  duplicate: "Duplicate",
  needsHuman: "Needs Human",
} as const;

const PROTECTED = new Set<string>([LINEAR_STATUS.review, LINEAR_STATUS.merge, LINEAR_STATUS.done]);

export interface BoardSetupPlan {
  /** Production never creates or renames Linear workflow states. */
  createColumns: false;
  inFlight: readonly string[];
  finished: string;
  finishedAlias: string;
  system: readonly string[];
  escalationPreferred: string;
  escalationFallback: string;
}

export function boardSetupPlan(): BoardSetupPlan {
  return {
    createColumns: false,
    inFlight: [
      LINEAR_STATUS.triage,
      LINEAR_STATUS.backlog,
      LINEAR_STATUS.todo,
      LINEAR_STATUS.inProgress,
      LINEAR_STATUS.review,
      LINEAR_STATUS.merge,
    ],
    finished: LINEAR_STATUS.done,
    finishedAlias: "Completed",
    system: [LINEAR_STATUS.canceled, LINEAR_STATUS.duplicate],
    escalationPreferred: LINEAR_STATUS.needsHuman,
    escalationFallback: LINEAR_STATUS.inProgress,
  };
}

export type CiState = "green" | "red" | "pending";

export type WorkflowEffect =
  | { kind: "github.draft" }
  | { kind: "github.ready" }
  | { kind: "github.merge" }
  /** Re-request review and comment. Never converts the pull request back to a draft. */
  | { kind: "github.rereview"; comment: string }
  | { kind: "linear.status"; status: string }
  | { kind: "linear.comment"; body: string }
  | { kind: "linear.revert"; stateId: string }
  | { kind: "linear.escalate"; comment: string };

/** Worktree file the implementation agent reads after Review sends the issue back. */
export const REVIEW_FEEDBACK_FILE = "linear-review-feedback.md";

export interface ReviewNote {
  login: string;
  state: string;
  body: string;
}

export interface WorkflowDecision {
  ok: boolean;
  /** Stop the autonomous chain after applying effects. */
  halt: boolean;
  reason: string;
  ciFailureCount: number;
  effects: WorkflowEffect[];
}

export function readCiFailEscalateAfter(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[CI_FAIL_ESCALATE_ENV]?.trim() ?? "";
  if (!raw) return DEFAULT_CI_FAIL_ESCALATE_AFTER;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return DEFAULT_CI_FAIL_ESCALATE_AFTER;
  return value;
}

export function normalizeStatus(name: string): string {
  const trimmed = name.trim();
  if (trimmed.toLowerCase() === "completed") return LINEAR_STATUS.done;
  return trimmed;
}

export function escalationComment(input: {
  whenIso: string;
  why: string;
  tried: string;
  failed: string;
}): string {
  return [
    "Human help needed",
    `When: ${input.whenIso}`,
    `Why: ${input.why}`,
    `Tried: ${input.tried}`,
    `Failed: ${input.failed}`,
  ].join("\n");
}

/** One line the coding agent may emit. The orchestrator escalates instead of looping. */
export function readBlindAlley(
  text: string,
): { why: string; tried: string; failed: string } | undefined {
  const match =
    /^LINEAR_BLIND_ALLEY\s+why:\s*(.*?)\s*\|\s*tried:\s*(.*?)\s*\|\s*failed:\s*(.*)$/m.exec(text);
  if (!match) return undefined;
  const why = match[1]?.trim() ?? "";
  const tried = match[2]?.trim() ?? "";
  const failed = match[3]?.trim() ?? "";
  if (!why || !tried || !failed) return undefined;
  return { why, tried, failed };
}

export function mapCommitStatus(state: string): CiState {
  if (state === "success") return "green";
  if (state === "pending") return "pending";
  return "red";
}

/** Latest review per login. Changes requested, or a comment with a body, blocks Review. */
export function blockingReviewFeedback(notes: readonly ReviewNote[]): string | undefined {
  const latest = new Map<string, ReviewNote>();
  for (const note of notes) {
    const login = note.login.trim();
    if (!login) continue;
    latest.set(login, note);
  }
  const lines: string[] = [];
  for (const note of latest.values()) {
    const state = note.state.trim();
    const body = note.body.trim();
    if (state === "CHANGES_REQUESTED" || (state === "COMMENTED" && body)) {
      lines.push(body ? `${note.login.trim()}: ${body}` : `${note.login.trim()} requested changes`);
    }
  }
  if (lines.length === 0) return undefined;
  return lines.join("\n");
}

/** Same commit and the same feedback are one failed return, not a new attempt. */
export function reviewFailureKey(sha: string, feedback?: string): string {
  return `${sha.trim()}\n${feedback?.trim() ?? ""}`;
}

export function reviewLoopComment(input: {
  failed: string;
  mustFix: string;
  attempt: number;
  escalateAfter: number;
}): string {
  return [
    "Review feedback",
    `Failed: ${input.failed}`,
    `Must fix: ${input.mustFix}`,
    `Attempt: ${input.attempt}/${input.escalateAfter}`,
  ].join("\n");
}

const agentWrites = new Map<string, { status: string; expiresAt: number }>();
const AGENT_WRITE_MS = 60_000;

export function noteAgentStatusWrite(issueId: string, status: string, nowMs: number): void {
  agentWrites.set(issueId, { status: normalizeStatus(status), expiresAt: nowMs + AGENT_WRITE_MS });
}

export function consumeAgentStatusWrite(issueId: string, status: string, nowMs: number): boolean {
  const row = agentWrites.get(issueId);
  if (!row) return false;
  agentWrites.delete(issueId);
  if (nowMs >= row.expiresAt) return false;
  return row.status === normalizeStatus(status);
}

export function resetAgentStatusWrites(): void {
  agentWrites.clear();
}

export function decideAgentAdvance(input: {
  action: "start" | "review" | "merge" | "blind_alley" | "triage";
  ci?: CiState;
  ciFailureCount: number;
  escalateAfter: number;
  humanApproved?: boolean;
  whenIso: string;
  blindAlley?: { why: string; tried: string; failed: string };
  /** Concrete review comments. Empty means no open feedback. */
  reviewFeedback?: string;
  /** `reviewFailureKey` for this evaluation. Matches `lastFailureKey` to avoid a double count. */
  failureKey?: string;
  lastFailureKey?: string;
}): WorkflowDecision {
  const count = input.ciFailureCount;
  if (input.action === "start") {
    return ok("start_work", count, [
      { kind: "github.draft" },
      { kind: "linear.status", status: LINEAR_STATUS.inProgress },
    ]);
  }
  if (input.action === "triage") {
    return ok("triage", count, [{ kind: "linear.status", status: LINEAR_STATUS.triage }]);
  }
  if (input.action === "blind_alley") {
    const detail = input.blindAlley ?? {
      why: "Blind alley",
      tried: "Further attempts",
      failed: "Another attempt would not move the solution forward",
    };
    return escalate(count, input.whenIso, detail.why, detail.tried, detail.failed, "blind_alley");
  }
  if (input.action === "merge") {
    if (input.ci !== undefined || Boolean(input.reviewFeedback?.trim())) {
      const problem = reviewProblem(input);
      if (problem) return problem;
    }
    if (!input.humanApproved) {
      if (input.ci === "green") {
        return {
          ok: false,
          halt: false,
          reason: "awaiting_approval",
          ciFailureCount: 0,
          effects: [
            { kind: "github.ready" },
            { kind: "linear.status", status: LINEAR_STATUS.review },
          ],
        };
      }
      return deny("awaiting_approval", count);
    }
    return ok("merge", count, [
      { kind: "github.merge" },
      { kind: "linear.status", status: LINEAR_STATUS.merge },
      { kind: "linear.status", status: LINEAR_STATUS.done },
    ]);
  }
  const problem = reviewProblem(input);
  if (problem) return problem;
  return ok("review", 0, [
    { kind: "github.ready" },
    { kind: "linear.status", status: LINEAR_STATUS.review },
  ]);
}

function reviewProblem(input: {
  ci?: CiState;
  ciFailureCount: number;
  escalateAfter: number;
  whenIso: string;
  reviewFeedback?: string;
  failureKey?: string;
  lastFailureKey?: string;
}): WorkflowDecision | undefined {
  const feedback = input.reviewFeedback?.trim() ?? "";
  if (input.ci === "pending") return deny("ci_pending", input.ciFailureCount);
  if (input.ci === "green" && !feedback) return undefined;
  const count = input.ciFailureCount;
  if (input.failureKey && input.lastFailureKey && input.failureKey === input.lastFailureKey) {
    return deny("ci_unchanged", count);
  }
  const next = count + 1;
  const failed = feedback
    ? input.ci === "green"
      ? feedback
      : `GitHub checks red (tests, lint, or Actions). ${feedback}`
    : "GitHub checks red (tests, lint, or Actions)";
  const mustFix = feedback || "Make CI green (tests, lint, and Actions)";
  if (next >= input.escalateAfter) {
    const why =
      input.ci === "green"
        ? `Repeated review feedback (${next}/${input.escalateAfter})`
        : `Repeated CI failure (${next}/${input.escalateAfter})`;
    return escalate(next, input.whenIso, why, "In Progress → Review", failed, "ci_failures");
  }
  const body = reviewLoopComment({
    failed,
    mustFix,
    attempt: next,
    escalateAfter: input.escalateAfter,
  });
  return ok("return_to_progress", next, [
    { kind: "linear.status", status: LINEAR_STATUS.inProgress },
    { kind: "linear.comment", body },
    { kind: "github.rereview", comment: body },
  ]);
}

export function decideObservedMove(input: {
  toStatus: string;
  actor: "agent" | "human";
  fromStateId?: string;
}): WorkflowDecision {
  const to = normalizeStatus(input.toStatus);
  if (!PROTECTED.has(to) || input.actor === "agent") {
    return ok("observed", 0, []);
  }
  const fromStateId = input.fromStateId?.trim() ?? "";
  if (!fromStateId) return deny("human_override", 0);
  return {
    ok: false,
    halt: false,
    reason: "human_override",
    ciFailureCount: 0,
    effects: [{ kind: "linear.revert", stateId: fromStateId }],
  };
}

function escalate(
  ciFailureCount: number,
  whenIso: string,
  why: string,
  tried: string,
  failed: string,
  reason: string,
): WorkflowDecision {
  return {
    ok: true,
    halt: true,
    reason,
    ciFailureCount,
    effects: [
      {
        kind: "linear.escalate",
        comment: escalationComment({ whenIso, why, tried, failed }),
      },
    ],
  };
}

function ok(reason: string, ciFailureCount: number, effects: WorkflowEffect[]): WorkflowDecision {
  return { ok: true, halt: false, reason, ciFailureCount, effects };
}

function deny(reason: string, ciFailureCount: number): WorkflowDecision {
  return { ok: false, halt: false, reason, ciFailureCount, effects: [] };
}
