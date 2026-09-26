/**
 * Worktree-scoped tools. cwd for bash, and read/write targets, stay inside the worktree.
 */
import { spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type LoadSkillResult =
  | { ok: true; id: string; path: string; body: string }
  | {
      ok: false;
      id: string;
      reason: "outside_budget" | "not_in_index" | "missing_body" | "unreadable";
    };

export const HARNESS_TOOLS = ["read_file", "write_file", "bash", "load_skill"] as const;
export type HarnessTool = (typeof HARNESS_TOOLS)[number];

export class SandboxEscapeError extends Error {
  readonly code = "sandbox_escape";

  constructor(requested: string) {
    super(`Path escapes worktree cwd: ${requested}`);
    this.name = "SandboxEscapeError";
  }
}

export function resolveInsideWorktree(worktreePath: string, requested: string): string {
  const root = path.resolve(worktreePath);
  if (!requested || requested.trim() === "") throw new SandboxEscapeError(requested);
  const target = path.resolve(root, requested);
  const rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new SandboxEscapeError(requested);
  assertRealpathInside(root, target);
  return target;
}

function assertRealpathInside(root: string, target: string): void {
  let current = target;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
  const realRoot = realpathSync(root);
  const realCurrent = realpathSync(current);
  const rel = path.relative(realRoot, realCurrent);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new SandboxEscapeError(target);
  if (current !== target) {
    const combined = path.resolve(realCurrent, path.relative(current, target));
    const relCombined = path.relative(realRoot, combined);
    if (relCombined.startsWith("..") || path.isAbsolute(relCombined)) {
      throw new SandboxEscapeError(target);
    }
  }
}

export interface WorktreeSandbox {
  readonly cwd: string;
  readFile(relativePath: string): Promise<string>;
  writeFile(relativePath: string, contents: string): Promise<void>;
  bash(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  loadSkill(skillId: string): Promise<LoadSkillResult>;
}

export function createWorktreeSandbox(
  worktreePath: string,
  deps?: { loadSkill?: (skillId: string) => Promise<LoadSkillResult> },
): WorktreeSandbox {
  const cwd = realpathSync(path.resolve(worktreePath));
  if (!statSync(cwd).isDirectory()) {
    throw new SandboxEscapeError(worktreePath);
  }
  return {
    cwd,
    async readFile(relativePath) {
      return readFile(resolveInsideWorktree(cwd, relativePath), "utf8");
    },
    async writeFile(relativePath, contents) {
      const target = resolveInsideWorktree(cwd, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents, "utf8");
    },
    bash(command) {
      return runBash(cwd, command);
    },
    loadSkill(skillId) {
      if (!deps?.loadSkill) {
        return Promise.resolve({ ok: false, id: skillId, reason: "outside_budget" });
      }
      return deps.loadSkill(skillId);
    },
  };
}

function runBash(
  cwd: string,
  command: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (!command.trim()) {
    return Promise.resolve({ stdout: "", stderr: "empty command", exitCode: 127 });
  }
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], { cwd, timeout: 10_000 });
    let stdout = "";
    let stderr = "";
    const cap = 64_000;
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > cap) {
        stdout = stdout.slice(0, cap);
        child.kill();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > cap) stderr = stderr.slice(0, cap);
    });
    child.on("error", (error) => {
      resolve({ stdout, stderr: error.message, exitCode: 127 });
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}
