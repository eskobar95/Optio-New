/**
 * In-memory worktree sandbox. Writes must stay inside the agent path.
 * Two agents do not share a file map, and `..` cannot reach the other tree.
 */

export interface Worktree {
  agent_id: string;
  path: string;
  files: Map<string, string>;
}

export function createWorktree(root: string, agentId: string): Worktree {
  const safeRoot = root.replace(/\/+$/, "");
  const safeId = agentId.trim();
  if (!safeId || /[\\/]/.test(safeId) || safeId.includes("..")) {
    throw new Error("invalid_agent_id");
  }
  return { agent_id: safeId, path: `${safeRoot}/${safeId}`, files: new Map() };
}

export function writeScoped(
  tree: Worktree,
  requestedPath: string,
  content: string,
): { ok: true; path: string } | { ok: false; reason: "worktree_isolation" } {
  const relative = resolveInside(tree.path, requestedPath);
  if (relative === null) return { ok: false, reason: "worktree_isolation" };
  tree.files.set(relative, content);
  return { ok: true, path: `${tree.path}/${relative}` };
}

function resolveInside(root: string, requested: string): string | null {
  const rootNorm = root.replace(/\/+$/, "");
  const combined = requested.startsWith("/") ? requested : `${rootNorm}/${requested}`;
  const parts: string[] = [];
  for (const part of combined.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  const full = `/${parts.join("/")}`;
  const prefix = `${rootNorm}/`;
  if (!full.startsWith(prefix)) return null;
  const relative = full.slice(prefix.length);
  if (!relative) return null;
  return relative;
}

export interface IsolationProbe {
  isolated: boolean;
  reason: string;
  agent_a: Record<string, string>;
  agent_b: Record<string, string>;
}

/** Two agents, one cross-write via `..` and one via an absolute path. */
export function runIsolationProbe(): IsolationProbe {
  const root = "/optio/worktrees";
  const agentA = createWorktree(root, "agent-a");
  const agentB = createWorktree(root, "agent-b");
  const own = writeScoped(agentA, "note.txt", "alpha");
  const relativeAttack = writeScoped(agentB, "../agent-a/note.txt", "pwned");
  const absoluteAttack = writeScoped(agentB, "/optio/worktrees/agent-a/note.txt", "pwned");
  const sibling = writeScoped(agentB, "note.txt", "beta");
  const isolated =
    agentA.path !== agentB.path &&
    own.ok &&
    !relativeAttack.ok &&
    relativeAttack.reason === "worktree_isolation" &&
    !absoluteAttack.ok &&
    sibling.ok &&
    agentA.files.get("note.txt") === "alpha" &&
    agentB.files.get("note.txt") === "beta" &&
    !agentA.files.has("../agent-a/note.txt");
  return {
    isolated,
    reason: isolated ? "separate_paths" : "cross_write",
    agent_a: Object.fromEntries(agentA.files),
    agent_b: Object.fromEntries(agentB.files),
  };
}
