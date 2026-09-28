/**
 * Cursor CLI in-loop wrapper stub (ENG-21).
 * Ports for compaction, warden, skill/MCP pick, and a DecisionPort for later Jev.
 * Defaults are passthrough so happy-path CLI invoke stays unchanged.
 */

/** Default max chars for a single tool-result payload before truncation. */
export const DEFAULT_TOOL_RESULT_MAX_CHARS = 4_000;

/** Soft timeout for DecisionPort; exceeded → passthrough. */
export const DEFAULT_DECISION_TIMEOUT_MS = 50;

const MUTATION_TOOLS = new Set(["shell", "edit", "edit_file", "write"]);

export type TranscriptRole = "user" | "assistant" | "tool";

export interface TranscriptTurn {
  role: TranscriptRole;
  content: string;
  /** Optional tool name when role is tool. */
  name?: string;
}

export interface CompactionPort {
  compact(turns: readonly TranscriptTurn[]): TranscriptTurn[];
}

export type WardenActionKind = "shell" | "write" | "edit";

export interface WardenAction {
  kind: WardenActionKind;
  /** Tool id from allowed_tools when known. */
  tool?: string;
  detail?: string;
}

export interface WardenDecision {
  allow: boolean;
  reason: string;
}

export interface WardenPort {
  gate(action: WardenAction): WardenDecision | Promise<WardenDecision>;
}

export interface SkillMcpPickContext {
  prompt: string;
  allowedTools: readonly string[];
  stepId: string;
}

export interface SkillMcpPickResult {
  skills: string[];
  mcpServers: string[];
}

export interface SkillMcpPickPort {
  pick(ctx: SkillMcpPickContext): SkillMcpPickResult | Promise<SkillMcpPickResult>;
}

export type DecisionKind = "compact" | "warden" | "pick";

export interface DecisionRequest {
  kind: DecisionKind;
  /** Opaque context for a future Jev client. */
  payload?: unknown;
}

export type DecisionOutcome =
  | { type: "passthrough" }
  | { type: "warden"; decision: WardenDecision }
  | { type: "pick"; result: SkillMcpPickResult }
  | { type: "compact"; maxChars: number };

export interface DecisionPort {
  /**
   * Ask an external decider (Jev later). On timeout or decide failure, callers
   * treat the result as passthrough — this stub never calls HTTP.
   */
  decide(request: DecisionRequest): Promise<DecisionOutcome>;
}

export interface CursorWrapperPorts {
  compaction: CompactionPort;
  warden: WardenPort;
  pick: SkillMcpPickPort;
  decision: DecisionPort;
}

export interface ResolveWrapperOptions {
  /** Max tool-result chars for default compaction. */
  toolResultMaxChars?: number;
}

export function passthroughCompaction(
  maxChars: number = DEFAULT_TOOL_RESULT_MAX_CHARS,
): CompactionPort {
  return {
    compact(turns) {
      return applyCompaction(turns, maxChars);
    },
  };
}

export function passthroughWarden(): WardenPort {
  return {
    gate() {
      return { allow: true, reason: "passthrough" };
    },
  };
}

export function passthroughPick(): SkillMcpPickPort {
  return {
    pick() {
      return { skills: [], mcpServers: [] };
    },
  };
}

export function passthroughDecision(): DecisionPort {
  return {
    async decide() {
      return { type: "passthrough" };
    },
  };
}

export function resolveWrapperPorts(
  partial: Partial<CursorWrapperPorts> = {},
  options: ResolveWrapperOptions = {},
): CursorWrapperPorts {
  const maxChars = options.toolResultMaxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS;
  return {
    compaction: partial.compaction ?? passthroughCompaction(maxChars),
    warden: partial.warden ?? passthroughWarden(),
    pick: partial.pick ?? passthroughPick(),
    decision: partial.decision ?? passthroughDecision(),
  };
}

/**
 * Truncate stale/oversized tool results only. Never rewrite user or assistant text.
 */
export function applyCompaction(
  turns: readonly TranscriptTurn[],
  maxChars: number = DEFAULT_TOOL_RESULT_MAX_CHARS,
): TranscriptTurn[] {
  return turns.map((turn) => {
    if (turn.role !== "tool") return { ...turn };
    if (turn.content.length <= maxChars) return { ...turn };
    const truncated = turn.content.slice(0, maxChars);
    return {
      ...turn,
      content: `${truncated}\n…[truncated ${turn.content.length - maxChars} chars]`,
    };
  });
}

export function isMutationTool(tool: string): boolean {
  return MUTATION_TOOLS.has(tool);
}

export function wardenKindForTool(tool: string): WardenActionKind | null {
  if (tool === "shell") return "shell";
  if (tool === "write") return "write";
  if (tool === "edit" || tool === "edit_file") return "edit";
  return null;
}

export function mutationToolsFrom(allowedTools: readonly string[]): string[] {
  return allowedTools.filter(isMutationTool);
}

export function formatPickHint(pick: SkillMcpPickResult): string | null {
  const skills = pick.skills.map((s) => s.trim()).filter(Boolean);
  const mcp = pick.mcpServers.map((s) => s.trim()).filter(Boolean);
  if (skills.length === 0 && mcp.length === 0) return null;
  const lines: string[] = ["[optio-wrapper pick]"];
  if (skills.length > 0) lines.push(`skills: ${skills.join(", ")}`);
  if (mcp.length > 0) lines.push(`mcp: ${mcp.join(", ")}`);
  return lines.join("\n");
}

export function appendPickToPrompt(prompt: string, pick: SkillMcpPickResult): string {
  const hint = formatPickHint(pick);
  if (!hint) return prompt;
  return `${prompt}\n\n${hint}`;
}

function isTranscriptTurn(value: unknown): value is TranscriptTurn {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const role = record.role;
  return (
    (role === "user" || role === "assistant" || role === "tool") &&
    typeof record.content === "string"
  );
}

/**
 * When CLI stdout is a JSON object with a `turns` array, return those turns.
 * Normal Cursor `--print` result JSON has no `turns` → null (compaction no-op).
 */
export function parseTranscriptTurns(stdout: string): TranscriptTurn[] | null {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const turns = (parsed as Record<string, unknown>).turns;
    if (!Array.isArray(turns) || turns.length === 0) return null;
    if (!turns.every(isTranscriptTurn)) return null;
    return turns;
  } catch {
    return null;
  }
}

/**
 * Compact `turns` in CLI stdout JSON when present. Unchanged otherwise (happy path).
 */
export async function compactCliStdout(
  ports: CursorWrapperPorts,
  stdout: string,
  decisionTimeoutMs: number = DEFAULT_DECISION_TIMEOUT_MS,
): Promise<string> {
  const turns = parseTranscriptTurns(stdout);
  if (!turns) return stdout;

  const compactDecision = await withDecisionTimeout(
    ports.decision,
    { kind: "compact", payload: { turnCount: turns.length } },
    decisionTimeoutMs,
  );

  let compacted: TranscriptTurn[];
  if (compactDecision.type === "compact") {
    compacted = applyCompaction(turns, compactDecision.maxChars);
  } else {
    compacted = ports.compaction.compact(turns);
  }

  const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
  return `${JSON.stringify({ ...parsed, turns: compacted })}\n`;
}

type DecideSettled = { status: "ok"; value: DecisionOutcome } | { status: "error"; error: unknown };

async function withDecisionTimeout(
  decision: DecisionPort,
  request: DecisionRequest,
  timeoutMs: number,
): Promise<DecisionOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const decidePromise: Promise<DecideSettled> = decision.decide(request).then(
    (value) => ({ status: "ok", value }),
    (error: unknown) => ({ status: "error", error }),
  );

  try {
    const raced = await Promise.race([
      decidePromise,
      new Promise<DecideSettled>((resolve) => {
        timer = setTimeout(
          () => resolve({ status: "error", error: { timedOut: true } }),
          timeoutMs,
        );
      }),
    ]);

    if (raced.status === "ok") return raced.value;

    const err = raced.error;
    if (err && typeof err === "object" && "timedOut" in err) {
      // Late settle/reject must not become unhandledRejection.
      void decidePromise.then(
        () => undefined,
        () => undefined,
      );
      return { type: "passthrough" };
    }
    // DecisionPort failures (network / Jev down) → passthrough. Re-throw programmer bugs.
    if (err instanceof Error) return { type: "passthrough" };
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface PrepareCursorInvokeInput {
  prompt: string;
  allowedTools: readonly string[];
  stepId: string;
  ports: CursorWrapperPorts;
  decisionTimeoutMs?: number;
}

export type PrepareCursorInvokeResult =
  { ok: true; prompt: string; pick: SkillMcpPickResult } | { ok: false; observation: string };

/**
 * Pre-spawn control: DecisionPort (timeout→passthrough) → skill/MCP pick → one warden decide for all mutation tools.
 */
export async function prepareCursorInvoke(
  input: PrepareCursorInvokeInput,
): Promise<PrepareCursorInvokeResult> {
  const timeoutMs = input.decisionTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;
  const { ports } = input;

  const pickDecision = await withDecisionTimeout(
    ports.decision,
    { kind: "pick", payload: { stepId: input.stepId } },
    timeoutMs,
  );

  let pick: SkillMcpPickResult;
  if (pickDecision.type === "pick") {
    pick = pickDecision.result;
  } else {
    pick = await ports.pick.pick({
      prompt: input.prompt,
      allowedTools: input.allowedTools,
      stepId: input.stepId,
    });
  }

  const prompt = appendPickToPrompt(input.prompt, pick);
  const mutationTools = mutationToolsFrom(input.allowedTools);
  if (mutationTools.length === 0) {
    return { ok: true, prompt, pick };
  }

  const wardenDecision = await withDecisionTimeout(
    ports.decision,
    { kind: "warden", payload: { tools: mutationTools } },
    timeoutMs,
  );

  if (wardenDecision.type === "warden") {
    if (!wardenDecision.decision.allow) {
      return {
        ok: false,
        observation: `Permission denied by wrapper warden: ${wardenDecision.decision.reason}`,
      };
    }
    return { ok: true, prompt, pick };
  }

  for (const tool of mutationTools) {
    const kind = wardenKindForTool(tool);
    if (!kind) continue;
    const gate = await ports.warden.gate({ kind, tool });
    if (!gate.allow) {
      return {
        ok: false,
        observation: `Permission denied by wrapper warden: ${gate.reason}`,
      };
    }
  }

  return { ok: true, prompt, pick };
}
