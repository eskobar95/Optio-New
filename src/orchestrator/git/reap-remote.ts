/**
 * Remote half of `.cursor/skills/reap-worktree`.
 * Delete the issue branch only after land: the pull request is merged,
 * the task tip is on the base, and the worktree is clean.
 * `git push --delete` is not a force-push. Protected bases are never deleted.
 */
import { assertBranchName, assertNoForcePush, isProtectedBranch } from "./merge-update.js";

export function assertRemoteBranchDelete(args: readonly string[]): void {
  assertNoForcePush(args);
  if (args[0] !== "push" || !args.includes("--delete")) {
    throw new Error("expected push --delete");
  }
  const branch = args[args.length - 1] ?? "";
  assertBranchName(branch);
  if (branch.includes(":") || isProtectedBranch(branch)) {
    throw new Error("refusing to delete the target branch");
  }
}

export function remoteDeleteAllowed(input: {
  branch: string;
  base: string;
  ancestor: boolean;
  clean: boolean;
  pullMerged: boolean | undefined;
  pullState: string;
}): { delete: boolean; reason: string } {
  if (!input.clean) return { delete: false, reason: "dirty" };
  if (input.branch === input.base || isProtectedBranch(input.branch)) {
    return { delete: false, reason: "protected" };
  }
  if (input.pullState === "open" || input.pullMerged === false) {
    return { delete: false, reason: "not_merged" };
  }
  if (!input.ancestor) return { delete: false, reason: "not_on_base" };
  return { delete: true, reason: "landed" };
}
