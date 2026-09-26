/**
 * Tool allow / confirm / deny.
 * Hard deny (secrets, destructive ops, allow-list misses) never calls the advisor.
 */
import {
  actionText,
  authorizeToolAction,
  hostResource,
  isReadOnlyShellCommand,
  resolveGrantedTier,
} from "./permissions.js";
import { reserveToolAllowance } from "./allowance.js";
import { recordDeniedTool } from "./audit.js";
import { confidentChoice, consultAdvisor } from "./advisor.js";
import {
  normalizeToken,
  type DecisionAdvisor,
  type ToolContext,
  type ToolGateDecision,
  type ToolVerdict,
} from "./types.js";

const HARD_DENY_TOOLS = new Set([
  "read_secret",
  "write_secret",
  "printenv",
  "dump_env",
  "exfiltrate",
  "force_push",
  "reset_hard",
  "drop_database",
  "rm_rf",
  "delete_branch_protection",
]);

const CONFIRM_TOOLS = new Set([
  "git_push",
  "git_commit",
  "shell",
  "bash",
  "npm_install",
  "npm_publish",
  "deploy",
  "delete_file",
]);

const ALLOW_TOOLS = new Set([
  "read_file",
  "grep",
  "glob",
  "edit_file",
  "write_file",
  "run_tests",
  "typecheck",
  "lint",
  "list_dir",
]);

const SAFE_SHELL = /^(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:test|typecheck|lint|ci))\b/;

const PROTECTED_BRANCHES = new Set(["main", "master", "development"]);

function inspectedText(tool: string, context: ToolContext): string {
  return actionText({
    tool,
    command: context.command,
    path: context.path,
    args: context.args,
  });
}

function isSecret(text: string): boolean {
  const normalized = text.replace(/\\/g, "/");
  return (
    /(^|\/|\s)\.env($|\.)/m.test(normalized) ||
    /(^|[/\s])secrets\//m.test(normalized) ||
    /(^|\/|\s)id_rsa\b/m.test(normalized) ||
    /(^|\/|\s)id_ed25519\b/m.test(normalized) ||
    /(^|[/\s])credentials\.json\b/m.test(normalized) ||
    /(^|[/\s])\.ssh\//m.test(normalized) ||
    /\.pem\b/m.test(normalized) ||
    /(^|\/)api[-_]?keys?\.(json|txt|env|yml|yaml)$/im.test(normalized) ||
    /\bprintenv\b/.test(normalized) ||
    /\bexport\s+-p\b/.test(normalized)
  );
}

const SELF_CONFIG_PATH =
  /(^|[/\s])AGENTS\.md\b|(^|[/\s])docker-compose\.yml\b|(^|[/\s])Dockerfile\.kit-harness\b|(^|[/\s])tsconfig\.kit-harness\.json\b|(^|\/)src\/kit-harness(\/|$)|(^|\/)\.cursor(\/|$)|(^|\/)workflows(\/|$)/im;

function isSelfConfigMutation(tool: string, context: ToolContext): boolean {
  const candidates = [context.path ?? "", context.command ?? ""];
  const args = context.args ?? {};
  for (const key of ["path", "file", "filename", "target"]) {
    const value = args[key];
    if (typeof value === "string") candidates.push(value);
  }
  const hit = candidates.some(
    (value) => value.length > 0 && SELF_CONFIG_PATH.test(value.replace(/\\/g, "/")),
  );
  if (!hit) return false;
  if (tool === "edit_file" || tool === "write_file" || tool === "delete_file") return true;
  if (tool === "shell" || tool === "bash") return />>?|\btee\b|\bsed\b/.test(candidates.join("\n"));
  return false;
}

function isDestructive(text: string): boolean {
  return (
    /\brm\s+-rf\b/.test(text) ||
    /\bgit\s+reset\s+--hard\b/.test(text) ||
    /\bgit\s+clean\s+-\S*f/.test(text) ||
    /\bgit\s+push\b[^\n]*--force\b/.test(text) ||
    /\bdrop\s+(database|schema|table)\b/i.test(text) ||
    /\btruncate\s+table\b/i.test(text) ||
    /\bkubectl\s+delete\b/.test(text) ||
    /\bdocker\s+system\s+prune\b/.test(text) ||
    /\bcurl\b[^\n]*\|\s*(?:sh|bash)\b/.test(text) ||
    pushesProtectedBranch(text)
  );
}

function pushesProtectedBranch(text: string): boolean {
  if (!/\bgit\s+push\b/.test(text)) return false;
  const tokens = text.trim().split(/\s+/);
  const pushAt = tokens.findIndex((token) => token === "push");
  if (pushAt < 0) return false;
  const args = tokens.slice(pushAt + 1).filter((token) => !token.startsWith("-"));
  const ref = args[1] ?? args[0];
  if (!ref) return false;
  const dest = ref.includes(":") ? ref.slice(ref.lastIndexOf(":") + 1) : ref;
  return PROTECTED_BRANCHES.has(dest);
}

function needsConfirm(tool: string, text: string): boolean {
  return (
    CONFIRM_TOOLS.has(tool) ||
    /\bgit\s+push\b/.test(text) ||
    /\b(?:curl|wget)\b/.test(text) ||
    /\bnpm\s+publish\b/.test(text) ||
    /\bsudo\b/.test(text)
  );
}

function ruled(
  decision: ToolVerdict,
  reason: string,
  hard: boolean,
  engine: "rules" | "jev" = "rules",
): ToolGateDecision {
  return { decision, hard, reason, engine };
}

function permissionDeny(observation: string): ToolGateDecision {
  return { ...ruled("deny", "permission_denied", true), observation };
}

async function evaluateTool(
  name: string,
  context: ToolContext,
  advisor?: DecisionAdvisor | null,
): Promise<ToolGateDecision> {
  const text = inspectedText(name, context);
  if (HARD_DENY_TOOLS.has(name)) return ruled("deny", "hard_deny_tool", true);
  if (isDestructive(text)) return ruled("deny", "hard_deny_destructive", true);
  if (isSelfConfigMutation(name, context)) return ruled("deny", "self_config_mutation", true);

  const granted = resolveGrantedTier({
    permissionTier: context.permission_tier,
    stepId: context.step_id,
  });
  if (!granted.ok) return permissionDeny(granted.observation);

  const host = hostResource(text);
  if (host && granted.tier !== "host-admin") {
    const auth = authorizeToolAction({
      tier: granted.tier,
      tool: name,
      command: context.command,
      path: context.path,
      args: context.args,
    });
    if (!auth.ok) return permissionDeny(auth.observation);
  }
  if (!(host && granted.tier === "host-admin") && isSecret(text)) {
    return ruled("deny", "hard_deny_secret", true);
  }

  if (context.allowed_tools) {
    const allowed = new Set(context.allowed_tools.map(normalizeToken));
    if (!allowed.has(name)) return ruled("deny", "not_in_allowlist", true);
  }

  const auth = authorizeToolAction({
    tier: granted.tier,
    tool: name,
    command: context.command,
    path: context.path,
    args: context.args,
  });
  if (!auth.ok) return permissionDeny(auth.observation);

  const budget = reserveToolAllowance(context);
  if (budget?.exceeded) {
    return { ...ruled("deny", "tool_allowance_exceeded", true), allowance: budget.allowance };
  }

  const advice = confidentChoice(
    await consultAdvisor(advisor, "tool_gate", { tool: name, context }),
    ["allow", "confirm", "deny"],
  );
  const stamp = (decision: ToolGateDecision): ToolGateDecision =>
    budget && !budget.exceeded ? { ...decision, allowance: budget.allowance } : decision;

  if (advice === "allow" || advice === "confirm" || advice === "deny") {
    return stamp(ruled(advice, "advisor", false, "jev"));
  }

  const command = context.command ?? "";
  if ((name === "shell" || name === "bash") && SAFE_SHELL.test(command.trim())) {
    return stamp(ruled("allow", "safe_command", false));
  }
  if ((name === "shell" || name === "bash") && isReadOnlyShellCommand(command)) {
    return stamp(ruled("allow", "read_only_command", false));
  }
  if (needsConfirm(name, text)) return stamp(ruled("confirm", "confirm_tool", false));
  if (ALLOW_TOOLS.has(name)) return stamp(ruled("allow", "allow_tool", false));
  return stamp(ruled("deny", "unknown_tool", false));
}

export async function decideTool(
  tool: string,
  context: ToolContext = {},
  advisor?: DecisionAdvisor | null,
): Promise<ToolGateDecision> {
  const name = normalizeToken(tool);
  const decision = name
    ? await evaluateTool(name, context, advisor)
    : ruled("deny", "empty_tool", true);
  if (decision.decision === "deny") {
    recordDeniedTool({
      tool: name || "(empty)",
      reason: decision.reason,
      hard: decision.hard,
      command: context.command,
      agent_id: context.agent_id,
    });
  }
  return decision;
}
