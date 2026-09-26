/**
 * Quality and safety gate before a pull request is opened or merged.
 *
 * Tests, lint, and typecheck fail closed: a missing exit code is not a pass.
 * The diff review blocks secrets and destructive changes. Findings name the
 * path and the rule. They do not include secret bytes or command output.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { UnrecoverableError } from "bullmq";

const execFileAsync = promisify(execFile);

export const PR_SAFETY_CHECKS = ["test", "lint", "typecheck"] as const;

export type PrSafetyCheckName = (typeof PR_SAFETY_CHECKS)[number];

export interface PrSafetyCheck {
  /** Process exit code. Omitted means the command did not run. */
  exitCode?: number;
}

export interface PrSafetyInput {
  checks?: Partial<Record<PrSafetyCheckName, PrSafetyCheck | undefined>>;
  /**
   * Unified diff that was reviewed, including an empty string when the
   * worktree had no changes. Omitted means the diff was not reviewed.
   */
  diff?: string;
}

export interface PrSafetyFinding {
  kind: "secret" | "destructive";
  path: string;
  rule: string;
}

export interface PrSafetyDecision {
  verdict: "pass" | "fail";
  reason: string;
  hard: boolean;
  findings: PrSafetyFinding[];
}

export interface ShellResult {
  exitCode: number | undefined;
  stdout: string;
}

export interface ShellRunner {
  run(cwd: string, command: string, args: readonly string[]): Promise<ShellResult>;
}

export interface CollectPrSafetyOptions {
  /** Three-dot base for the committed pull-request diff. Default `development`. */
  base?: string;
  shell?: ShellRunner;
}

const CHECK_COMMANDS: ReadonlyArray<{ name: PrSafetyCheckName; args: readonly string[] }> = [
  { name: "test", args: ["test"] },
  { name: "lint", args: ["run", "lint"] },
  { name: "typecheck", args: ["run", "typecheck"] },
];

const NOT_RUN: Record<PrSafetyCheckName, string> = {
  test: "tests_not_run",
  lint: "lint_not_run",
  typecheck: "typecheck_not_run",
};

const FAILED: Record<PrSafetyCheckName, string> = {
  test: "tests_failed",
  lint: "lint_failed",
  typecheck: "typecheck_failed",
};

const SECRET_LINE: ReadonlyArray<{ rule: string; test: RegExp }> = [
  { rule: "private_key", test: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { rule: "aws_access_key", test: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: "github_token", test: /\bghp_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { rule: "slack_token", test: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { rule: "provider_secret", test: /\bsk-(?:live|test|proj|ant)-[A-Za-z0-9]{10,}\b/ },
];

const DESTRUCTIVE_LINE: ReadonlyArray<{ rule: string; test: RegExp }> = [
  { rule: "rm_rf", test: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f|\brm\s+-[a-zA-Z]*f[a-zA-Z]*r/ },
  { rule: "git_reset_hard", test: /\bgit\s+reset\s+--hard\b/ },
  { rule: "git_clean_force", test: /\bgit\s+clean\s+-\S*f/ },
  { rule: "force_push", test: /\bgit\s+push\b[^\n]*--force\b|\bgit\s+push\b[^\n]*(?:\s)-f\b/ },
  { rule: "drop_sql", test: /\bdrop\s+(?:database|schema|table)\b/i },
  { rule: "truncate_sql", test: /\btruncate\s+table\b/i },
  { rule: "kubectl_delete", test: /\bkubectl\s+delete\b/ },
  { rule: "docker_prune", test: /\bdocker\s+system\s+prune\b/ },
  { rule: "curl_pipe_shell", test: /\bcurl\b[^\n]*\|\s*(?:sh|bash)\b/ },
];

const ASSIGNED_SECRET =
  /\b(?:api[_-]?key|secret[_-]?key|aws_secret_access_key)\b\s*[:=]\s*['"]([^'"]+)['"]/i;

const PLACEHOLDER = /^(?:changeme|example|placeholder|redacted|your[_-]|xxx+|todo)\b/i;

const SAFE_REF = /^[A-Za-z0-9._/-]+$/;

const MAX_FINDINGS = 20;
const MAX_UNTRACKED = 200;

function decision(
  verdict: "pass" | "fail",
  reason: string,
  findings: PrSafetyFinding[],
): PrSafetyDecision {
  return { verdict, reason, hard: verdict === "fail", findings };
}

function checkReason(checks: PrSafetyInput["checks"]): string | null {
  const bag = checks ?? {};
  for (const name of PR_SAFETY_CHECKS) {
    const exitCode = bag[name]?.exitCode;
    if (typeof exitCode !== "number") return NOT_RUN[name];
    if (exitCode !== 0) return FAILED[name];
  }
  return null;
}

function secretPathRule(filePath: string): string | undefined {
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.split("/").includes("..")) return "path_escape";
  if (normalized.startsWith("/")) return "absolute_path";
  if (
    /(^|\/)\.env$/i.test(normalized) ||
    (/(^|\/)\.env\./i.test(normalized) && !/\.env\.(example|sample|template)$/i.test(normalized))
  ) {
    return "dotenv";
  }
  if (
    /(^|\/)secrets\//i.test(normalized) &&
    !/(^|\/)secrets\/README(?:\.md)?$/i.test(normalized) &&
    !/\.md$/i.test(normalized)
  ) {
    return "secrets_dir";
  }
  if (
    /(^|\/)id_(?:rsa|ed25519)$/.test(normalized) ||
    /\.pem$/i.test(normalized) ||
    /(^|\/)\.ssh\//.test(normalized)
  ) {
    return "private_key_file";
  }
  if (
    /(^|\/)credentials\.json$/i.test(normalized) ||
    /(^|\/)api[-_]?keys?\.(?:json|txt|env|ya?ml)$/i.test(normalized)
  ) {
    return "credentials_file";
  }
  return undefined;
}

function gitDestination(line: string): string | undefined {
  const quotedGit = /^diff --git "a\/.*" "b\/(.*)"$/.exec(line);
  if (quotedGit?.[1]) return quotedGit[1];
  const plainGit = /^diff --git a\/\S+ b\/(\S+)$/.exec(line);
  return plainGit?.[1];
}

/** `+++` destination. `/dev/null` means the file was deleted and is not reviewed as added. */
function plusDestination(line: string): string | undefined {
  if (!line.startsWith("+++ ")) return undefined;
  const rest = line.slice(4).trim();
  if (rest === "/dev/null") return undefined;
  const quoted = /^"b\/(.*)"$/.exec(rest);
  if (quoted?.[1]) return quoted[1];
  if (rest.startsWith("b/")) return rest.slice(2);
  return undefined;
}

function assignedSecret(line: string): boolean {
  const match = ASSIGNED_SECRET.exec(line);
  const value = match?.[1];
  if (!value || value.length < 12) return false;
  if (PLACEHOLDER.test(value)) return false;
  if (value.includes("process.env") || value.includes("${")) return false;
  return true;
}

function protectedPush(line: string): boolean {
  if (!/\bgit\s+push\b/.test(line)) return false;
  return /\b(?:main|master|development)\b/.test(line);
}

function pushFinding(findings: PrSafetyFinding[], finding: PrSafetyFinding): void {
  if (findings.length >= MAX_FINDINGS) return;
  const seen = findings.some(
    (item) =>
      item.kind === finding.kind && item.path === finding.path && item.rule === finding.rule,
  );
  if (!seen) findings.push(finding);
}

function flagPath(findings: PrSafetyFinding[], flaggedPaths: Set<string>, path: string): void {
  if (flaggedPaths.has(path)) return;
  flaggedPaths.add(path);
  const rule = secretPathRule(path);
  if (rule === "path_escape" || rule === "absolute_path") {
    pushFinding(findings, { kind: "destructive", path, rule });
  } else if (rule) {
    pushFinding(findings, { kind: "secret", path, rule });
  }
}

function reviewDiff(diff: string): PrSafetyFinding[] {
  const findings: PrSafetyFinding[] = [];
  const flaggedPaths = new Set<string>();
  let current = "(diff)";
  let pending: string | undefined;
  for (const raw of diff.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const fromGit = gitDestination(line);
    if (fromGit) {
      pending = fromGit;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const path = plusDestination(line);
      pending = undefined;
      if (!path) {
        current = "(diff)";
        continue;
      }
      current = path;
      flagPath(findings, flaggedPaths, path);
      continue;
    }
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    if (pending) {
      current = pending;
      flagPath(findings, flaggedPaths, pending);
      pending = undefined;
    }
    const added = line.slice(1);
    for (const rule of SECRET_LINE) {
      if (rule.test.test(added)) {
        pushFinding(findings, { kind: "secret", path: current, rule: rule.rule });
      }
    }
    if (assignedSecret(added)) {
      pushFinding(findings, { kind: "secret", path: current, rule: "assigned_secret" });
    }
    for (const rule of DESTRUCTIVE_LINE) {
      if (rule.test.test(added)) {
        pushFinding(findings, { kind: "destructive", path: current, rule: rule.rule });
      }
    }
    if (protectedPush(added)) {
      pushFinding(findings, { kind: "destructive", path: current, rule: "protected_branch_push" });
    }
  }
  return findings;
}

/**
 * Secrets and destructive paths outrank a red check so the fail reason names
 * the leak. A missing check still fails when the diff is clean.
 */
export function evaluatePrSafetyGate(input: PrSafetyInput | null | undefined): PrSafetyDecision {
  const source = input ?? {};
  const findings = typeof source.diff === "string" ? reviewDiff(source.diff) : [];
  const secret = findings.find((item) => item.kind === "secret");
  if (secret) return decision("fail", "secret_in_diff", findings);
  const destructive = findings.find((item) => item.kind === "destructive");
  if (destructive) return decision("fail", "destructive_path", findings);
  const blocked = checkReason(source.checks);
  if (blocked) return decision("fail", blocked, findings);
  if (typeof source.diff !== "string") return decision("fail", "diff_not_reviewed", []);
  return decision("pass", "checks_passed", []);
}

function safeBase(base: string): boolean {
  return (
    SAFE_REF.test(base) && !base.includes("..") && !base.startsWith("-") && !base.startsWith("/")
  );
}

function usableDiff(exitCode: number | undefined): boolean {
  return exitCode === 0 || exitCode === 1;
}

function stdoutText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
}

export function createExecFileShell(): ShellRunner {
  return {
    async run(cwd, command, args) {
      try {
        const { stdout } = await execFileAsync(command, [...args], {
          cwd,
          encoding: "utf8",
          timeout: 10 * 60 * 1000,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, CI: "1", HUSKY: "0", GIT_TERMINAL_PROMPT: "0" },
        });
        return { exitCode: 0, stdout: stdoutText(stdout) };
      } catch (error) {
        const failed = error as { code?: unknown; stdout?: unknown };
        const exitCode = typeof failed.code === "number" ? failed.code : undefined;
        return { exitCode, stdout: stdoutText(failed.stdout) };
      }
    },
  };
}

async function readDiff(
  cwd: string,
  base: string,
  shell: ShellRunner,
): Promise<string | undefined> {
  if (!safeBase(base)) return undefined;
  const committed = await shell.run(cwd, "git", ["diff", `${base}...HEAD`]);
  const unstaged = await shell.run(cwd, "git", ["diff", "HEAD"]);
  const untracked = await shell.run(cwd, "git", [
    "ls-files",
    "-z",
    "--others",
    "--exclude-standard",
  ]);
  if (
    !usableDiff(committed.exitCode) ||
    !usableDiff(unstaged.exitCode) ||
    untracked.exitCode !== 0
  ) {
    return undefined;
  }
  const names = untracked.stdout.split("\0").filter((name) => name.length > 0);
  if (names.length > MAX_UNTRACKED) return undefined;
  const parts = [committed.stdout, unstaged.stdout];
  for (const name of names) {
    if (name.split("/").includes("..") || name.startsWith("/") || name.startsWith("-")) {
      parts.push(`diff --git a/${name} b/${name}\n+++ b/${name}\n`);
      continue;
    }
    const fileDiff = await shell.run(cwd, "git", ["diff", "--no-index", "--", "/dev/null", name]);
    if (!usableDiff(fileDiff.exitCode)) return undefined;
    parts.push(fileDiff.stdout);
  }
  return parts.join("\n");
}

/** Read the diff before npm so a secret or destructive change is not executed. */
export async function collectPrSafetyInput(
  cwd: string,
  options: CollectPrSafetyOptions = {},
): Promise<PrSafetyInput> {
  const shell = options.shell ?? createExecFileShell();
  const base = options.base?.trim() || "development";
  const diff = await readDiff(cwd, base, shell);
  if (diff === undefined) return {};
  if (reviewDiff(diff).length > 0) return { diff };
  const checks: NonNullable<PrSafetyInput["checks"]> = {};
  for (const check of CHECK_COMMANDS) {
    const result = await shell.run(cwd, "npm", check.args);
    checks[check.name] = { exitCode: result.exitCode };
  }
  return { checks, diff };
}

/** Ready and merge must not push or merge. BullMQ does not retry this in place. */
export class PrSafetyClosedError extends UnrecoverableError {
  readonly decision: PrSafetyDecision;

  constructor(decision: PrSafetyDecision) {
    const finding = decision.findings[0];
    const detail = finding ? ` ${finding.path} (${finding.rule})` : "";
    super(`pr safety gate closed: ${decision.reason}${detail}`);
    this.name = "PrSafetyClosedError";
    this.decision = decision;
  }
}
