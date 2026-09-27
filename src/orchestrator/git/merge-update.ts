/**
 * Update a task branch with its pull-request base before land.
 * Publish with a normal push of head:head. Never force-push. Never push the base.
 */
import { hannesFeedbackComment, parseReviewVerdict } from "../linear/review-verdict.js";

const FORCE_FLAG = /^(?:-f|--force|--force-with-lease|--force-if-includes)$/;
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const PROTECTED = new Set(["main", "development", "master", "staging", "production"]);

export function assertBranchName(name: string): void {
  if (!BRANCH_NAME.test(name) || name.includes("..") || name.endsWith("/") || name.includes("@{")) {
    throw new Error("refusing unsafe branch name");
  }
}

export function isProtectedBranch(name: string): boolean {
  return PROTECTED.has(name) || name.startsWith("lanes/");
}

export function assertNoForcePush(args: readonly string[]): void {
  for (const arg of args) {
    if (FORCE_FLAG.test(arg) || arg.startsWith("--force")) {
      throw new Error("force-push is forbidden");
    }
  }
}

/** Last arg must be head:head. The remote URL is not a refspec. */
export function assertHeadOnlyPush(
  args: readonly string[],
  headBranch: string,
  baseBranch: string,
): void {
  assertNoForcePush(args);
  if (args[0] !== "push") throw new Error("expected push");
  const refspec = args[args.length - 1] ?? "";
  if (refspec !== `${headBranch}:${headBranch}`) {
    throw new Error("push must update the task branch only");
  }
  if (headBranch === baseBranch || isProtectedBranch(headBranch)) {
    throw new Error("refusing to push the target branch");
  }
}

/**
 * Pull-request base. The stored base wins.
 * Linear opens against `main`. Other tasks use the catalog default (`development`
 * unless `OPTIO_NEW_BASE_BRANCH` is set). Callers pass that fallback in.
 */
export function baseForPull(storedBase: string | undefined, fallback: string): string {
  const base = storedBase?.trim() || fallback.trim();
  assertBranchName(base);
  return base;
}

export type UpdateNeed = "current" | "update" | "conflict";

export function classifyAgainstBase(input: {
  ancestor: boolean;
  mergeTreeConflict: boolean;
}): UpdateNeed {
  if (input.ancestor) return "current";
  if (input.mergeTreeConflict) return "conflict";
  return "update";
}

export function conflictStillPresent(input: {
  unmerged: string;
  markerHits: string;
  verdict: "pass" | "fail";
}): boolean {
  if (input.verdict !== "pass") return true;
  if (input.unmerged.trim()) return true;
  if (input.markerHits.trim()) return true;
  return false;
}

export function dirtyPaths(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(line.lastIndexOf(" ") + 1).trim())
    .filter(Boolean)
    .slice(0, 8);
}

export function mergeConflictFeedback(input: {
  text: string;
  unmerged: string;
  attempt: number;
  escalateAfter: number;
}): string {
  const parsed = parseReviewVerdict(input.text);
  if (parsed.files.length === 0) {
    parsed.files = input.unmerged
      .split("\n")
      .map((file) => file.trim())
      .filter(Boolean)
      .slice(0, 8);
  }
  return hannesFeedbackComment({
    verdict: parsed,
    attempt: input.attempt,
    escalateAfter: input.escalateAfter,
  });
}

export interface MergeGit {
  (args: readonly string[]): Promise<string>;
}

const COMMIT_IDENTITY = [
  "-c",
  "user.name=optio-new",
  "-c",
  "user.email=optio-new@users.noreply.github.com",
] as const;

export async function prepareMergeWorktree(input: {
  git: MergeGit;
  base: string;
  headBranch: string;
  remote: string;
  attempt: number;
  escalateAfter: number;
  /** Agent text. Invoked only when the merge has unmerged paths. */
  resolveConflict: (unmerged: string) => Promise<string>;
}): Promise<{ ok: true; updated: boolean } | { ok: false; feedback: string }> {
  assertBranchName(input.base);
  assertBranchName(input.headBranch);
  if (input.headBranch === input.base || isProtectedBranch(input.headBranch)) {
    return {
      ok: false,
      feedback: mergeConflictFeedback({
        text: [
          "OPTIO_REVIEW_VERDICT fail",
          `Files: ${input.headBranch}`,
          "Standards: never push the target branch",
          `Spec: land updates ${input.headBranch} only`,
          "Slop: none",
          "Expected: keep the task branch distinct from the pull request base",
        ].join("\n"),
        unmerged: input.headBranch,
        attempt: input.attempt,
        escalateAfter: input.escalateAfter,
      }),
    };
  }
  const dirty = await input.git(["status", "--porcelain"]);
  if (dirty.trim()) {
    const files = dirtyPaths(dirty).join(", ");
    return {
      ok: false,
      feedback: mergeConflictFeedback({
        text: [
          "OPTIO_REVIEW_VERDICT fail",
          `Files: ${files}`,
          "Standards: clean worktree",
          "Spec: merge requires a clean task branch",
          "Slop: none",
          "Expected: commit or remove local changes before updating against the base",
        ].join("\n"),
        unmerged: files,
        attempt: input.attempt,
        escalateAfter: input.escalateAfter,
      }),
    };
  }
  await input.git(["fetch", input.remote, input.base]);
  const ancestor = await succeeded(input.git, [
    "merge-base",
    "--is-ancestor",
    "FETCH_HEAD",
    "HEAD",
  ]);
  if (ancestor) return { ok: true, updated: false };
  const cleanTree = await succeeded(input.git, [
    "merge-tree",
    "--write-tree",
    "--name-only",
    "HEAD",
    "FETCH_HEAD",
  ]);
  const need = classifyAgainstBase({ ancestor: false, mergeTreeConflict: !cleanTree });
  if (need === "update") {
    const merged = await succeeded(input.git, [
      ...COMMIT_IDENTITY,
      "merge",
      "--no-ff",
      "--no-edit",
      "FETCH_HEAD",
    ]);
    if (!merged) {
      await abortMerge(input.git);
      return {
        ok: false,
        feedback: mergeConflictFeedback({
          text: [
            "OPTIO_REVIEW_VERDICT fail",
            "Files: (merge)",
            "Standards: clean merge",
            `Spec: update ${input.headBranch} with ${input.base}`,
            "Slop: none",
            "Expected: merge the base into the task branch without rewriting either history",
          ].join("\n"),
          unmerged: "",
          attempt: input.attempt,
          escalateAfter: input.escalateAfter,
        }),
      };
    }
    pushHead(input);
    await input.git(["push", input.remote, `${input.headBranch}:${input.headBranch}`]);
    return { ok: true, updated: true };
  }
  await input
    .git([...COMMIT_IDENTITY, "merge", "--no-ff", "--no-commit", "FETCH_HEAD"])
    .catch(() => "");
  const unmerged = await input.git(["diff", "--name-only", "--diff-filter=U"]);
  if (!unmerged.trim()) {
    const committed = await succeeded(input.git, [...COMMIT_IDENTITY, "commit", "--no-edit"]);
    if (!committed) {
      await abortMerge(input.git);
      return {
        ok: false,
        feedback: mergeConflictFeedback({
          text: [
            "OPTIO_REVIEW_VERDICT fail",
            "Files: (merge)",
            "Standards: clean merge",
            "Spec: finish the base update commit",
            "Slop: none",
            "Expected: complete the merge commit on the task branch",
          ].join("\n"),
          unmerged: "",
          attempt: input.attempt,
          escalateAfter: input.escalateAfter,
        }),
      };
    }
    pushHead(input);
    await input.git(["push", input.remote, `${input.headBranch}:${input.headBranch}`]);
    return { ok: true, updated: true };
  }
  let text = "";
  try {
    text = await input.resolveConflict(unmerged);
  } catch {
    text = "OPTIO_REVIEW_VERDICT fail\nExpected: resolver failed before a clean tree";
  }
  const parsed = parseReviewVerdict(text);
  const unmergedAfter = await input.git(["diff", "--name-only", "--diff-filter=U"]);
  const markerHits = await markerGrep(input.git);
  if (
    conflictStillPresent({
      unmerged: unmergedAfter,
      markerHits,
      verdict: parsed.verdict,
    })
  ) {
    await abortMerge(input.git);
    return {
      ok: false,
      feedback: mergeConflictFeedback({
        text,
        unmerged: unmergedAfter.trim() || unmerged,
        attempt: input.attempt,
        escalateAfter: input.escalateAfter,
      }),
    };
  }
  await input.git(["add", "-A"]);
  const committed = await succeeded(input.git, [...COMMIT_IDENTITY, "commit", "--no-edit"]);
  if (!committed) {
    await abortMerge(input.git);
    return {
      ok: false,
      feedback: mergeConflictFeedback({
        text: [
          "OPTIO_REVIEW_VERDICT fail",
          `Files: ${unmerged.trim()}`,
          "Standards: clean merge",
          "Spec: commit the conflict resolution",
          "Slop: none",
          "Expected: commit the resolved files on the task branch",
        ].join("\n"),
        unmerged,
        attempt: input.attempt,
        escalateAfter: input.escalateAfter,
      }),
    };
  }
  pushHead(input);
  await input.git(["push", input.remote, `${input.headBranch}:${input.headBranch}`]);
  return { ok: true, updated: true };
}

function pushHead(input: { headBranch: string; base: string; remote: string }): void {
  assertHeadOnlyPush(
    ["push", input.remote, `${input.headBranch}:${input.headBranch}`],
    input.headBranch,
    input.base,
  );
}

async function abortMerge(git: MergeGit): Promise<void> {
  await git(["merge", "--abort"]).catch(() => "");
}

async function succeeded(git: MergeGit, args: readonly string[]): Promise<boolean> {
  try {
    await git(args);
    return true;
  } catch {
    return false;
  }
}

async function markerGrep(git: MergeGit): Promise<string> {
  try {
    return await git(["grep", "-n", "-E", "^<<<<<<< |^>>>>>>> ", "--", "."]);
  } catch {
    return "";
  }
}
