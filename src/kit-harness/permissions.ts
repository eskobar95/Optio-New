/**
 * Permission tiers for agent shell, git, and host actions (SPEC §13.8).
 * CodingAgent adapters and the kit-harness tool gate both call this module.
 * host-admin is never a stage default.
 */

export const PERMISSION_TIERS = ["read-only", "edit-worktree", "git-push", "host-admin"] as const;

export type PermissionTier = (typeof PERMISSION_TIERS)[number];

/** Workflow step ids in `workflows/default-task.yaml`. */
export const WORKFLOW_STAGE_PERMISSION: Record<string, PermissionTier> = {
  planner: "read-only",
  implementation: "edit-worktree",
  review: "read-only",
  ready: "git-push",
  merge: "git-push",
};

const STEP_ALIASES: Record<string, keyof typeof WORKFLOW_STAGE_PERMISSION> = {
  plan: "planner",
  invoke_planner: "planner",
  implement: "implementation",
  invoke_implementation: "implementation",
  invoke_review: "review",
  open_pr: "ready",
  merge_branch: "merge",
};

export type AgentSandbox = "read-only" | "workspace-write" | "host";

export type HostResource = "sops" | "root" | "docker.sock";

const TIER_RANK: Record<PermissionTier, number> = {
  "read-only": 0,
  "edit-worktree": 1,
  "git-push": 2,
  "host-admin": 3,
};

const TIER_CAPABILITY: Record<PermissionTier, string> = {
  "read-only": "read the worktree",
  "edit-worktree": "edit files inside the worktree",
  "git-push": "git push a non-protected branch",
  "host-admin": "touch sops keys, /root, and docker.sock",
};

const EDIT_TOOLS = new Set([
  "edit",
  "edit_file",
  "write",
  "write_file",
  "delete_file",
  "shell",
  "bash",
  "npm_install",
  "run_tests",
]);

const GIT_PUSH_TOOLS = new Set(["git_push", "git", "push", "deploy", "npm_publish"]);

const HOST_TOOLS = new Set(["host", "docker", "sops", "host_admin"]);

const INSPECTED_ARG_KEYS = ["command", "cmd", "path", "file", "filename", "target", "url"];

export function isPermissionTier(value: string): value is PermissionTier {
  return (PERMISSION_TIERS as readonly string[]).includes(value);
}

export function defaultPermissionForStep(stepId?: string): PermissionTier {
  const id = stepId?.trim() ?? "";
  if (!id) return "read-only";
  const direct = WORKFLOW_STAGE_PERMISSION[id];
  if (direct) return direct;
  const alias = STEP_ALIASES[id];
  if (alias) return WORKFLOW_STAGE_PERMISSION[alias];
  return "read-only";
}

export function permissionObservation(input: {
  granted: PermissionTier | "unknown";
  required: PermissionTier;
  action: string;
}): string {
  const capability =
    input.granted === "unknown"
      ? "do nothing until a known tier is set"
      : TIER_CAPABILITY[input.granted];
  return [
    `Permission denied (${input.granted}).`,
    `${input.action} was not executed.`,
    `This tier can ${capability}.`,
    `Required tier: ${input.required}.`,
    "sops keys, /root, and docker.sock require host-admin.",
  ].join(" ");
}

export function resolveGrantedTier(input: {
  permissionTier?: string;
  stepId?: string;
}): { ok: true; tier: PermissionTier } | { ok: false; observation: string } {
  const explicit = input.permissionTier?.trim();
  if (explicit) {
    if (!isPermissionTier(explicit)) {
      return {
        ok: false,
        observation: permissionObservation({
          granted: "unknown",
          required: "read-only",
          action: `Tier "${explicit}"`,
        }),
      };
    }
    return { ok: true, tier: explicit };
  }
  return { ok: true, tier: defaultPermissionForStep(input.stepId) };
}

export function actionText(input: {
  tool: string;
  command?: string;
  path?: string;
  args?: Record<string, unknown>;
}): string {
  const parts = [input.tool, input.command ?? "", input.path ?? ""];
  const args = input.args ?? {};
  for (const key of INSPECTED_ARG_KEYS) {
    const value = args[key];
    if (typeof value === "string") parts.push(value);
  }
  return parts.join("\n");
}

export function hostResource(text: string): HostResource | null {
  const normalized = text.replace(/\\/g, "/");
  if (/docker\.sock\b/.test(normalized)) return "docker.sock";
  if (/(?:^|[\s"'`=])\/root(?:\/|$)/m.test(normalized) || normalized.trim() === "/root") {
    return "root";
  }
  if (isSopsKeyMaterial(normalized)) return "sops";
  return null;
}

/** A shell that only inspects the worktree. Metacharacters keep it out of this class. */
export function isReadOnlyShellCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || /[;&|`$<>]/.test(trimmed)) return false;
  return /^(?:git\s+(?:status|diff|log|show|blame|rev-parse)(?:\s+\S+)*|ls(?:\s+\S+)*|pwd|cat(?:\s+\S+)*|head(?:\s+\S+)*|tail(?:\s+\S+)*|rg(?:\s+\S+)*|grep(?:\s+\S+)*)$/.test(
    trimmed,
  );
}

export function requiredTierForAction(tool: string, text: string): PermissionTier | null {
  if (hostResource(text)) return "host-admin";
  const name = normalizeTool(tool);
  if (HOST_TOOLS.has(name) || /\bsudo\b/.test(text) || /\bdocker\b/.test(text)) return "host-admin";
  if (GIT_PUSH_TOOLS.has(name) || /\bgit\s+push\b/.test(text)) return "git-push";
  if (EDIT_TOOLS.has(name) || /\bgit\s+commit\b/.test(text)) {
    if ((name === "shell" || name === "bash") && isReadOnlyShellCommand(commandOf(text))) {
      return null;
    }
    return "edit-worktree";
  }
  return null;
}

export function authorizeToolAction(input: {
  tier: PermissionTier;
  tool: string;
  command?: string;
  path?: string;
  args?: Record<string, unknown>;
}): { ok: true } | { ok: false; observation: string } {
  const text = actionText(input);
  const required = requiredTierForAction(input.tool, text);
  if (!required || TIER_RANK[input.tier] >= TIER_RANK[required]) return { ok: true };
  return {
    ok: false,
    observation: permissionObservation({
      granted: input.tier,
      required,
      action: actionLabel(input.tool, text, required),
    }),
  };
}

export function tierRequestedByTools(tools: readonly string[]): PermissionTier {
  let rank = 0;
  for (const tool of tools) {
    const name = normalizeTool(tool);
    if (HOST_TOOLS.has(name)) rank = Math.max(rank, TIER_RANK["host-admin"]);
    else if (GIT_PUSH_TOOLS.has(name)) rank = Math.max(rank, TIER_RANK["git-push"]);
    else if (EDIT_TOOLS.has(name)) rank = Math.max(rank, TIER_RANK["edit-worktree"]);
  }
  return PERMISSION_TIERS[rank] ?? "read-only";
}

export function authorizeAgentRun(input: {
  allowedTools: readonly string[];
  permissionTier?: string;
  stepId?: string;
}): { ok: true; tier: PermissionTier; sandbox: AgentSandbox } | { ok: false; observation: string } {
  const granted = resolveGrantedTier({
    permissionTier: input.permissionTier,
    stepId: input.stepId,
  });
  if (!granted.ok) return granted;
  const requested = tierRequestedByTools(input.allowedTools);
  if (TIER_RANK[requested] > TIER_RANK[granted.tier]) {
    return {
      ok: false,
      observation: permissionObservation({
        granted: granted.tier,
        required: requested,
        action: `allowed_tools [${input.allowedTools.join(", ")}]`,
      }),
    };
  }
  return {
    ok: true,
    tier: granted.tier,
    sandbox: sandboxFor(granted.tier, requested),
  };
}

export function codexSandboxMode(
  sandbox: AgentSandbox,
): "read-only" | "workspace-write" | "danger-full-access" {
  if (sandbox === "host") return "danger-full-access";
  if (sandbox === "workspace-write") return "workspace-write";
  return "read-only";
}

export function cursorSandboxArgs(sandbox: AgentSandbox): string[] {
  if (sandbox === "read-only") return ["--sandbox", "enabled"];
  if (sandbox === "workspace-write") return ["--sandbox", "enabled", "--force"];
  return ["--force"];
}

function sandboxFor(granted: PermissionTier, requested: PermissionTier): AgentSandbox {
  const effective = Math.min(TIER_RANK[granted], TIER_RANK[requested]);
  if (effective >= TIER_RANK["host-admin"]) return "host";
  if (effective <= TIER_RANK["read-only"]) return "read-only";
  return "workspace-write";
}

function actionLabel(tool: string, text: string, required: PermissionTier): string {
  const host = hostResource(text);
  if (host === "docker.sock") return "Access to docker.sock";
  if (host === "root") return "Access to /root";
  if (host === "sops") return "Access to sops keys";
  if (required === "git-push") return "git push";
  if (required === "edit-worktree") return "Editing the worktree";
  return tool;
}

function commandOf(text: string): string {
  const lines = text.split("\n");
  return lines[1] ?? "";
}

function isSopsKeyMaterial(normalized: string): boolean {
  if (/\.sops\.yaml(?!\.example)\b/.test(normalized)) return true;
  if (/(?:^|[\s/])age\.key\b/.test(normalized)) return true;
  if (/\.agekey\b/.test(normalized)) return true;
  if (/\/\.config\/sops\//.test(normalized) || /\/sops\/age\//.test(normalized)) return true;
  if (/(?:^|[\s/])keys\.txt\b/.test(normalized) && /(?:sops|age)/.test(normalized)) return true;
  if (/(?:^|[;&|`\n\s])sops(?:\s|$)/m.test(normalized)) return true;
  if (/\bage-keygen\b/.test(normalized)) return true;
  if (/\bage\b/.test(normalized) && /(?:--decrypt|\s-d\b)/.test(normalized)) return true;
  return false;
}

function normalizeTool(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}
