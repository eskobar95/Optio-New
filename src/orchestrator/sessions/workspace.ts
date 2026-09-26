import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  assertSafeId,
  SessionGateError,
  WorktreeAlreadyExistsError,
  type SessionWorkspace,
  type SessionWorkspaceClaim,
  type SessionWorkspacePort,
  type WorktreeManagerLike,
} from "./types.js";

function prefix(dir: string): string {
  return dir.endsWith(sep) ? dir : dir + sep;
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(prefix(root));
}

/**
 * Lexical containment, then a realpath check so a symlink inside the workspace
 * cannot redirect a write into another session's tree.
 */
async function resolveInside(root: string, relativePath: string): Promise<string> {
  if (!relativePath || isAbsolute(relativePath) || relativePath.includes("\0")) {
    throw new SessionGateError("workspace_escape", "path escapes workspace");
  }
  const rootResolved = resolve(root);
  const lexical = resolve(rootResolved, relativePath);
  if (!isInside(rootResolved, lexical) || lexical === rootResolved) {
    throw new SessionGateError("workspace_escape", "path escapes workspace");
  }
  const parent = dirname(lexical);
  await mkdir(parent, { recursive: true });
  const [rootReal, parentReal] = await Promise.all([realpath(rootResolved), realpath(parent)]);
  const realTarget = join(parentReal, lexical.slice(parent.length + 1));
  if (!isInside(rootReal, realTarget)) {
    throw new SessionGateError("workspace_escape", "path escapes workspace");
  }
  return realTarget;
}

/** Write a file that must stay inside the claimed workspace. */
export async function writeSessionFile(
  workspace: SessionWorkspace,
  relativePath: string,
  contents: string,
): Promise<void> {
  const target = await resolveInside(workspace.path, relativePath);
  await writeFile(target, contents);
}

/** Read a file that must stay inside the claimed workspace. */
export async function readSessionFile(
  workspace: SessionWorkspace,
  relativePath: string,
): Promise<string> {
  const target = await resolveInside(workspace.path, relativePath);
  return readFile(target, "utf8");
}

/**
 * In-process workspace claim keyed by task id.
 * Used until the worktree manager (issue #6) is wired; paths are unique under `root`.
 */
export function createPathWorkspacePort(root: string): SessionWorkspacePort {
  const claims = new Map<string, SessionWorkspace>();

  return {
    async claim(request: SessionWorkspaceClaim): Promise<SessionWorkspace> {
      assertSafeId(request.sessionId, "sessionId");
      assertSafeId(request.taskId, "taskId");
      if (claims.has(request.taskId)) {
        throw new SessionGateError(
          "workspace_busy",
          `task ${request.taskId} already has a workspace`,
        );
      }
      const worktreeId = `wt-${request.taskId}`;
      const lexical = resolve(root, worktreeId);
      const rootResolved = resolve(root);
      if (!isInside(rootResolved, lexical)) {
        throw new SessionGateError("workspace_escape", "worktree path escapes root");
      }
      const placeholder: SessionWorkspace = {
        sessionId: request.sessionId,
        taskId: request.taskId,
        worktreeId,
        path: lexical,
      };
      claims.set(request.taskId, placeholder);
      try {
        await mkdir(lexical, { recursive: true });
        const canonical = await realpath(lexical);
        for (const existing of claims.values()) {
          if (existing.taskId !== request.taskId && existing.path === canonical) {
            throw new SessionGateError("workspace_busy", `path ${canonical} is already claimed`);
          }
        }
        const workspace: SessionWorkspace = { ...placeholder, path: canonical };
        claims.set(request.taskId, workspace);
        return workspace;
      } catch (err) {
        claims.delete(request.taskId);
        throw err;
      }
    },

    async release(workspace: SessionWorkspace): Promise<void> {
      const current = claims.get(workspace.taskId);
      if (current?.sessionId === workspace.sessionId) {
        claims.delete(workspace.taskId);
      }
    },
  };
}

/**
 * Adapt a worktree manager. `release` forgets the claim and does not reap.
 * Reap-on-merge stays in the manager (SPEC §7).
 */
export function workspacePortFromWorktreeManager(
  manager: WorktreeManagerLike,
): SessionWorkspacePort {
  const claims = new Map<string, SessionWorkspace>();

  return {
    async claim(request: SessionWorkspaceClaim): Promise<SessionWorkspace> {
      assertSafeId(request.sessionId, "sessionId");
      assertSafeId(request.taskId, "taskId");
      if (claims.has(request.taskId)) {
        throw new SessionGateError(
          "workspace_busy",
          `task ${request.taskId} already has a workspace`,
        );
      }
      const placeholder: SessionWorkspace = {
        sessionId: request.sessionId,
        taskId: request.taskId,
        worktreeId: "",
        path: "",
      };
      claims.set(request.taskId, placeholder);
      try {
        const created = await manager.create(request.taskId);
        if (!created.worktreeId || !created.path || !isAbsolute(created.path)) {
          throw new SessionGateError(
            "invalid_request",
            "worktree manager must return an absolute path and worktreeId",
          );
        }
        for (const existing of claims.values()) {
          if (existing.taskId === request.taskId) continue;
          if (existing.path === created.path || existing.worktreeId === created.worktreeId) {
            throw new SessionGateError(
              "workspace_busy",
              `worktree ${created.worktreeId} collides with another task`,
            );
          }
        }
        const workspace: SessionWorkspace = {
          sessionId: request.sessionId,
          taskId: request.taskId,
          worktreeId: created.worktreeId,
          path: created.path,
        };
        claims.set(request.taskId, workspace);
        return workspace;
      } catch (err) {
        claims.delete(request.taskId);
        if (
          err instanceof WorktreeAlreadyExistsError ||
          (err instanceof SessionGateError && err.code === "workspace_busy")
        ) {
          throw new SessionGateError(
            "workspace_busy",
            `task ${request.taskId} already has a workspace`,
          );
        }
        throw err;
      }
    },

    async release(workspace: SessionWorkspace): Promise<void> {
      const current = claims.get(workspace.taskId);
      if (current?.sessionId === workspace.sessionId) {
        claims.delete(workspace.taskId);
      }
    },
  };
}
