/**
 * repoId → clone URL, local checkout, default branch, and worktree root.
 * A missing selector resolves to the catalog default. Linear is not a repo source.
 */
import { parse } from "yaml";
import { z } from "zod";

export const DEFAULT_REPO_ID = "default";

/** Safe path token. BullMQ job ids also reject `:`. */
export const REPO_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const RepoIdSchema = z.string().regex(REPO_ID_PATTERN, "repoId must be a safe token");

const RepoBindingSchema = z.object({
  repoId: RepoIdSchema,
  cloneUrl: z.string().min(1),
  localPath: z.string().min(1),
  defaultBranch: z.string().min(1),
  worktreeRoot: z.string().min(1),
});

export type RepoBinding = z.infer<typeof RepoBindingSchema>;

export interface RepoCatalog {
  defaultRepoId: string;
  repos: readonly RepoBinding[];
}

export class RepoCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoCatalogError";
  }
}

export class UnknownRepoError extends Error {
  readonly repoId: string;

  constructor(repoId: string) {
    super(`unknown repoId ${JSON.stringify(repoId)}`);
    this.name = "UnknownRepoError";
    this.repoId = repoId;
  }
}

const DEFAULT_CLONE_URL = "https://github.com/eskobar95/Optio-New.git";
const DEFAULT_LOCAL_PATH = "/opt/optio-new";
const DEFAULT_BRANCH = "development";
const DEFAULT_WORKTREE_ROOT = "/var/lib/optio-new/worktrees";

function readTrimmed(env: NodeJS.ProcessEnv, key: string): string {
  return env[key]?.trim() ?? "";
}

function defaultCloneUrl(env: NodeJS.ProcessEnv): string {
  const explicit = readTrimmed(env, "OPTIO_NEW_REPO_CLONE_URL");
  if (explicit) return explicit;
  const slug = readTrimmed(env, "OPTIO_NEW_GITHUB_REPO");
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug)) {
    return `https://github.com/${slug}.git`;
  }
  return DEFAULT_CLONE_URL;
}

function syntheticCatalog(env: NodeJS.ProcessEnv): RepoCatalog {
  const repoId = readTrimmed(env, "OPTIO_NEW_DEFAULT_REPO_ID") || DEFAULT_REPO_ID;
  const parsedId = RepoIdSchema.safeParse(repoId);
  if (!parsedId.success) {
    throw new RepoCatalogError("OPTIO_NEW_DEFAULT_REPO_ID must be a safe token");
  }
  const binding: RepoBinding = {
    repoId: parsedId.data,
    cloneUrl: defaultCloneUrl(env),
    localPath: readTrimmed(env, "OPTIO_NEW_REPO_PATH") || DEFAULT_LOCAL_PATH,
    defaultBranch: readTrimmed(env, "OPTIO_NEW_BASE_BRANCH") || DEFAULT_BRANCH,
    worktreeRoot: readTrimmed(env, "OPTIO_NEW_WORKTREE_ROOT") || DEFAULT_WORKTREE_ROOT,
  };
  return { defaultRepoId: binding.repoId, repos: [binding] };
}

function issueText(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "repos"}: ${issue.message}`)
    .join("; ");
}

/**
 * `OPTIO_NEW_REPOS` is a JSON array of bindings. Empty uses one default checkout
 * from OPTIO_NEW_REPO_PATH / OPTIO_NEW_WORKTREE_ROOT / OPTIO_NEW_BASE_BRANCH.
 * Parse errors do not echo the raw value.
 */
export function loadRepoCatalog(env: NodeJS.ProcessEnv = process.env): RepoCatalog {
  const raw = readTrimmed(env, "OPTIO_NEW_REPOS");
  if (!raw) return syntheticCatalog(env);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new RepoCatalogError("OPTIO_NEW_REPOS must be a JSON array");
  }
  const result = z.array(RepoBindingSchema).min(1).safeParse(parsed);
  if (!result.success) {
    throw new RepoCatalogError(`OPTIO_NEW_REPOS is invalid: ${issueText(result.error)}`);
  }

  const seen = new Set<string>();
  for (const repo of result.data) {
    if (seen.has(repo.repoId)) {
      throw new RepoCatalogError(`duplicate repoId ${JSON.stringify(repo.repoId)}`);
    }
    seen.add(repo.repoId);
  }

  const requestedDefault = readTrimmed(env, "OPTIO_NEW_DEFAULT_REPO_ID") || result.data[0]?.repoId;
  if (!requestedDefault || !seen.has(requestedDefault)) {
    throw new RepoCatalogError(
      `default repoId ${JSON.stringify(requestedDefault ?? "")} is not in OPTIO_NEW_REPOS`,
    );
  }
  return { defaultRepoId: requestedDefault, repos: result.data };
}

export function resolveRepo(catalog: RepoCatalog, repoId?: string): RepoBinding {
  const requested = repoId?.trim() || catalog.defaultRepoId;
  const found = catalog.repos.find((repo) => repo.repoId === requested);
  if (!found) throw new UnknownRepoError(requested);
  return found;
}

/** Task selector, then workflow `repo_id`, then the catalog default. */
export function selectRepoId(input: {
  catalog: RepoCatalog;
  requested?: string;
  workflowRepoId?: string;
}): string {
  const requested = input.requested?.trim();
  if (requested) return resolveRepo(input.catalog, requested).repoId;
  const workflow = input.workflowRepoId?.trim();
  if (workflow) return resolveRepo(input.catalog, workflow).repoId;
  return resolveRepo(input.catalog).repoId;
}

/**
 * Match a GitHub repository onto the catalog. A single-repo catalog always
 * uses its default. A multi-repo catalog with no clone URL / full_name match
 * throws so the task is not created on the wrong checkout.
 */
export function matchRepoId(
  catalog: RepoCatalog,
  hint: { fullName?: string; cloneUrl?: string },
): string {
  const full = hint.fullName?.trim().toLowerCase() ?? "";
  const clone = hint.cloneUrl?.trim().toLowerCase() ?? "";
  for (const repo of catalog.repos) {
    const repoClone = repo.cloneUrl.trim().toLowerCase();
    if (clone && repoClone === clone) return repo.repoId;
    if (full && repo.repoId.toLowerCase() === full) return repo.repoId;
    if (full && (repoClone.endsWith(`/${full}.git`) || repoClone.endsWith(`/${full}`))) {
      return repo.repoId;
    }
  }
  if (catalog.repos.length === 1) return catalog.defaultRepoId;
  throw new UnknownRepoError(full || clone || "(github repository)");
}

/** Workflow may set `repo_id`. Omitted means the catalog default. */
export function readWorkflowRepoId(workflowYaml: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = parse(workflowYaml) as unknown;
  } catch {
    throw new RepoCatalogError("workflow YAML is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  if (!("repo_id" in parsed)) return undefined;
  const value = (parsed as { repo_id?: unknown }).repo_id;
  if (value === undefined || value === null || value === "") return undefined;
  const id = RepoIdSchema.safeParse(value);
  if (!id.success) throw new RepoCatalogError("workflow repo_id must be a safe token");
  return id.data;
}
