import { describe, expect, it } from "vitest";
import {
  assertHeadOnlyPush,
  assertNoForcePush,
  baseForPull,
  classifyAgainstBase,
  conflictStillPresent,
  prepareMergeWorktree,
} from "../src/orchestrator/git/merge-update.js";

describe("merge update", () => {
  it("refuses a force-push and a push of the target branch", () => {
    expect(() => assertNoForcePush(["push", "origin", "--force", "task/a:task/a"])).toThrow(
      /force-push/,
    );
    expect(() => assertNoForcePush(["push", "--force-with-lease"])).toThrow(/force-push/);
    expect(() =>
      assertHeadOnlyPush(["push", "https://example.test/repo.git", "main:main"], "main", "main"),
    ).toThrow(/target branch/);
    expect(() =>
      assertHeadOnlyPush(
        ["push", "https://example.test/repo.git", "task/a:main"],
        "task/a",
        "main",
      ),
    ).toThrow(/task branch only/);
    assertHeadOnlyPush(
      ["push", "https://x-access-token:secret@github.com/acme/widgets.git", "task/a:task/a"],
      "task/a",
      "main",
    );
  });

  it("uses the stored pull request base, then the catalog fallback", () => {
    expect(baseForPull("main", "development")).toBe("main");
    expect(baseForPull(undefined, "development")).toBe("development");
    expect(baseForPull("  ", "development")).toBe("development");
  });

  it("classifies a behind branch as an update or a conflict", () => {
    expect(classifyAgainstBase({ ancestor: true, mergeTreeConflict: false })).toBe("current");
    expect(classifyAgainstBase({ ancestor: false, mergeTreeConflict: false })).toBe("update");
    expect(classifyAgainstBase({ ancestor: false, mergeTreeConflict: true })).toBe("conflict");
    expect(conflictStillPresent({ unmerged: "src/app.ts", markerHits: "", verdict: "pass" })).toBe(
      true,
    );
    expect(conflictStillPresent({ unmerged: "", markerHits: "", verdict: "pass" })).toBe(false);
  });

  it("merges a clean base update and pushes the task branch only", async () => {
    const calls: string[] = [];
    const prepared = await prepareMergeWorktree({
      git: async (args) => {
        calls.push(args.join(" "));
        const verb = args.find((arg) =>
          ["status", "fetch", "merge-base", "merge-tree", "merge", "push"].includes(arg),
        );
        if (verb === "merge-base") throw new Error("not ancestor");
        return "";
      },
      base: "main",
      headBranch: "task/lin-ENG-9",
      remote: "https://example.test/repo.git",
      attempt: 1,
      escalateAfter: 3,
      resolveConflict: async () => {
        throw new Error("resolver should not run");
      },
    });
    expect(prepared).toEqual({ ok: true, updated: true });
    expect(calls.some((call) => call.includes("merge --no-ff --no-edit FETCH_HEAD"))).toBe(true);
    expect(calls.some((call) => call.endsWith("task/lin-ENG-9:task/lin-ENG-9"))).toBe(true);
    expect(calls.join("\n")).not.toContain("--force");
    expect(calls.join("\n")).not.toContain("main:main");
  });

  it("aborts an unsafe conflict and returns the review handoff", async () => {
    const calls: string[] = [];
    const prepared = await prepareMergeWorktree({
      git: async (args) => {
        calls.push(args.join(" "));
        const verb = args.find((arg) =>
          ["status", "fetch", "merge-base", "merge-tree", "merge", "diff", "grep", "push"].includes(
            arg,
          ),
        );
        if (verb === "merge-base" || verb === "merge-tree" || verb === "grep") {
          throw new Error("conflict");
        }
        if (verb === "diff") return "src/gate.ts";
        return "";
      },
      base: "development",
      headBranch: "task/lin-ENG-7",
      remote: "https://example.test/repo.git",
      attempt: 1,
      escalateAfter: 3,
      resolveConflict: async () =>
        [
          "OPTIO_REVIEW_VERDICT fail",
          "Files: src/gate.ts",
          "Standards: seam overlap",
          "Spec: keep both callers",
          "Slop: none",
          "Expected: merge the helper without dropping the new check",
        ].join("\n"),
    });
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) {
      expect(prepared.feedback).toContain("Verdict: fail");
      expect(prepared.feedback).toContain("Files: src/gate.ts");
      expect(prepared.feedback).toContain("Standards: seam overlap");
      expect(prepared.feedback).toContain("Expected: merge the helper");
      expect(prepared.feedback).toContain("in-task fix only");
    }
    expect(calls.some((call) => call === "merge --abort")).toBe(true);
    expect(calls.some((call) => call.startsWith("push "))).toBe(false);
  });
});
