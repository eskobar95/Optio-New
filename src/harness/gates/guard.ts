import {
  CANONICAL_SPAN,
  getStageTracer,
  type StageTracer,
} from "../../orchestrator/telemetry/index.js";
import {
  classifyPath,
  commandMutatesLockedConfig,
  commandReferencesSecret,
  isLockedConfigPath,
  isSecretRelativePath,
  matchedLockedConfigToken,
  matchedSecretToken,
} from "./policy.js";
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  type AuditEvent,
  type AuditSink,
  type DecisionSidecar,
  type GateDecision,
  type GuardedToolResult,
  type ModelToolCall,
  type ToolCallRequest,
} from "./types.js";

const SECRET_DENY: GateDecision = {
  verdict: "deny",
  gate: "secrets",
  reason: "secret path denied",
  audited: true,
};

const ESCAPE_DENY: GateDecision = {
  verdict: "deny",
  gate: "secrets",
  reason: "path escapes the worktree",
  audited: true,
};

const CONFIG_DENY: GateDecision = {
  verdict: "deny",
  gate: "config_lock",
  reason: "harness config write denied",
  audited: true,
};

const HARD_ALLOW: GateDecision = {
  verdict: "allow",
  gate: "none",
  reason: "hard gates passed",
  audited: false,
};

const SKILL_BUDGET_DENY: GateDecision = {
  verdict: "deny",
  gate: "skill_budget",
  reason: "load_skill denied: outside the active skill budget",
  audited: true,
};

export interface GuardToolCallOptions {
  request: ToolCallRequest;
  execute: (call: ModelToolCall, signal: AbortSignal) => Promise<unknown>;
  audit: AuditSink;
  sidecar?: DecisionSidecar;
  timeoutMs?: number;
  now?: () => Date;
  tracer?: StageTracer;
}

/** Deterministic preflight. Null means the hard gates allow the call. */
export function evaluateHardGates(request: ToolCallRequest): GateDecision | null {
  if (request.tool === "load_skill") {
    const budget = request.skillBudget ?? [];
    if (!request.skillId || !budget.includes(request.skillId)) return SKILL_BUDGET_DENY;
  }

  if (request.path) {
    const classified = classifyPath(request.path, request.worktreeRoot);
    if (isSecretRelativePath(classified.relative)) return SECRET_DENY;
    if (classified.escaped) return ESCAPE_DENY;
    if (request.action === "write" && isLockedConfigPath(classified.relative)) return CONFIG_DENY;
  }

  if (request.command && commandReferencesSecret(request.command)) return SECRET_DENY;
  if (request.command && commandMutatesLockedConfig(request.command)) return CONFIG_DENY;
  return null;
}

export async function guardToolCall(options: GuardToolCallOptions): Promise<GuardedToolResult> {
  const tracer = options.tracer ?? getStageTracer();
  const stepId = options.request.stepId;
  return tracer.runStage(
    CANONICAL_SPAN.gatePass,
    {
      taskId: options.request.taskId ?? "",
      worktreeId: "",
      attributes: stepId ? { step_id: stepId } : undefined,
    },
    async (span) => {
      const result = await runGuardedToolCall(options);
      span.setAttribute("gate_id", result.decision.gate);
      if (result.status !== "allowed") {
        span.setName(CANONICAL_SPAN.gateFail);
        span.setAttribute("error_class", result.decision.gate);
        span.fail(result.decision.reason);
      }
      return result;
    },
  );
}

async function runGuardedToolCall(options: GuardToolCallOptions): Promise<GuardedToolResult> {
  const hard = evaluateHardGates(options.request);
  if (hard) {
    await auditDeny(options, hard);
    return { status: "denied", decision: hard };
  }

  if (options.sidecar) {
    const advice = await options.sidecar.advise(options.request);
    if (advice.verdict !== "allow") {
      const decision: GateDecision = {
        verdict: "deny",
        gate: "sidecar",
        reason: advice.reason || "sidecar denied the tool call",
        audited: true,
      };
      await auditDeny(options, decision);
      return { status: "denied", decision };
    }
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const outcome = await runWithTimeout(
    (signal) => options.execute(toModelToolCall(options.request), signal),
    timeoutMs,
  );

  if (!outcome.ok) {
    const decision: GateDecision = {
      verdict: "deny",
      gate: "tool_timeout",
      reason: outcome.reason,
      audited: true,
    };
    await auditDeny(options, decision);
    return { status: "cancelled", decision };
  }

  return { status: "allowed", value: outcome.value, decision: { ...HARD_ALLOW } };
}

function toModelToolCall(request: ToolCallRequest): ModelToolCall {
  return {
    tool: request.tool,
    action: request.action,
    path: request.path,
    command: request.command,
    ...(request.skillId ? { skillId: request.skillId } : {}),
  };
}

async function auditDeny(options: GuardToolCallOptions, decision: GateDecision): Promise<void> {
  const gate = decision.gate;
  if (gate === "none") return;

  const event: AuditEvent = {
    at: (options.now ?? (() => new Date()))().toISOString(),
    gate,
    verdict: "deny",
    action: options.request.action,
    tool: options.request.tool,
    reason: decision.reason,
  };
  if (options.request.taskId) event.taskId = options.request.taskId;
  if (options.request.stepId) event.stepId = options.request.stepId;
  const auditedPath = options.request.path ?? inferredAuditPath(options.request, decision.gate);
  if (auditedPath) event.path = auditedPath;
  await options.audit.record(event);
}

function inferredAuditPath(
  request: ToolCallRequest,
  gate: GateDecision["gate"],
): string | undefined {
  if (!request.command) return undefined;
  if (gate === "secrets") return matchedSecretToken(request.command);
  if (gate === "config_lock") return matchedLockedConfigToken(request.command);
  return undefined;
}

function runWithTimeout<T>(
  execute: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  const controller = new AbortController();
  const reason = `tool timed out after ${timeoutMs}ms and was cancelled`;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, reason });
    }, timeoutMs);

    execute(controller.signal).then(
      (value) => {
        clearTimeout(timer);
        if (controller.signal.aborted) {
          resolve({ ok: false, reason });
          return;
        }
        resolve({ ok: true, value });
      },
      (error: unknown) => {
        clearTimeout(timer);
        if (controller.signal.aborted) {
          resolve({ ok: false, reason });
          return;
        }
        reject(error);
      },
    );
  });
}
