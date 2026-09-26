/**
 * Tool allow / confirm / deny.
 * Hard deny (secrets, destructive ops, allow-list misses) never calls the advisor.
 */
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

const INSPECTED_ARG_KEYS = ["command", "cmd", "path", "file", "filename", "target", "url"];

const SAFE_SHELL = /^(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:test|typecheck|lint|ci))\b/;

const PROTECTED_BRANCHES = new Set(["main", "master", "development"]);

function inspectedText(tool: string, context: ToolContext): string {
  const parts = [tool, context.command ?? "", context.path ?? ""];
  const args = context.args ?? {};
  for (const key of INSPECTED_ARG_KEYS) {
    const value = args[key];
    if (typeof value === "string") parts.push(value);
  }
  return parts.join("\n");
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
    /\bprintenv\b/.test(normalized) ||
    /\bexport\s+-p\b/.test(normalized)
  );
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

export async function decideTool(
  tool: string,
  context: ToolContext = {},
  advisor?: DecisionAdvisor | null,
): Promise<ToolGateDecision> {
  const name = normalizeToken(tool);
  if (!name) return ruled("deny", "empty_tool", true);

  const text = inspectedText(name, context);
  if (HARD_DENY_TOOLS.has(name)) return ruled("deny", "hard_deny_tool", true);
  if (isSecret(text)) return ruled("deny", "hard_deny_secret", true);
  if (isDestructive(text)) return ruled("deny", "hard_deny_destructive", true);

  if (context.allowed_tools) {
    const allowed = new Set(context.allowed_tools.map(normalizeToken));
    if (!allowed.has(name)) return ruled("deny", "not_in_allowlist", true);
  }

  const advice = confidentChoice(
    await consultAdvisor(advisor, "tool_gate", { tool: name, context }),
    ["allow", "confirm", "deny"],
  );
  if (advice === "allow" || advice === "confirm" || advice === "deny") {
    return ruled(advice, "advisor", false, "jev");
  }

  const command = context.command ?? "";
  if ((name === "shell" || name === "bash") && SAFE_SHELL.test(command.trim())) {
    return ruled("allow", "safe_command", false);
  }
  if (needsConfirm(name, text)) return ruled("confirm", "confirm_tool", false);
  if (ALLOW_TOOLS.has(name)) return ruled("allow", "allow_tool", false);
  return ruled("deny", "unknown_tool", false);
}
