/**
 * Orchestrator worktree settings (SPEC §7).
 * Git worktrees, not a container per task. See docs/ops/worktree-isolation.md.
 */
import type { StageTracer } from "../telemetry/index.js";
import { WorktreeManager } from "./manager.js";

export interface WorktreeRuntimeConfig {
  root: string;
  repoPath: string;
  baseBranch: string;
  retainOnFailure: boolean;
}

const DEFAULT_ROOT = "/var/lib/optio-new/worktrees";
const DEFAULT_REPO = "/opt/optio-new";
const DEFAULT_BASE = "development";

function readString(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw.trim();
}

function readRetainOnFailure(env: NodeJS.ProcessEnv): boolean {
  const raw = env.OPTIO_NEW_WORKTREE_RETAIN_ON_FAILURE;
  if (raw === undefined || raw.trim() === "") return true;
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("OPTIO_NEW_WORKTREE_RETAIN_ON_FAILURE must be true or false");
}

/** Defaults match the Compose orchestrator service on the kit-harness host. */
export function loadWorktreeRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): WorktreeRuntimeConfig {
  return {
    root: readString(env, "OPTIO_NEW_WORKTREE_ROOT", DEFAULT_ROOT),
    repoPath: readString(env, "OPTIO_NEW_REPO_PATH", DEFAULT_REPO),
    baseBranch: readString(env, "OPTIO_NEW_BASE_BRANCH", DEFAULT_BASE),
    retainOnFailure: readRetainOnFailure(env),
  };
}

export function createWorktreeManagerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  tracer?: StageTracer,
): WorktreeManager {
  const config = loadWorktreeRuntimeConfig(env);
  return new WorktreeManager({
    root: config.root,
    repoPath: config.repoPath,
    baseBranch: config.baseBranch,
    retainOnFailure: config.retainOnFailure,
    tracer,
  });
}
