import { describe, expect, it } from "vitest";
import {
  assertRemoteBranchDelete,
  remoteDeleteAllowed,
} from "../src/orchestrator/git/reap-remote.js";

const landed = {
  branch: "task/lin-ENG-9",
  base: "main",
  ancestor: true,
  clean: true,
  pullMerged: true as boolean | undefined,
  pullState: "closed",
};

describe("reap remote branch", () => {
  it("deletes only a landed task branch", () => {
    expect(remoteDeleteAllowed(landed)).toEqual({ delete: true, reason: "landed" });
    expect(remoteDeleteAllowed({ ...landed, pullMerged: undefined })).toEqual({
      delete: true,
      reason: "landed",
    });
    expect(remoteDeleteAllowed({ ...landed, pullMerged: false }).delete).toBe(false);
    expect(remoteDeleteAllowed({ ...landed, pullState: "open" }).delete).toBe(false);
    expect(remoteDeleteAllowed({ ...landed, ancestor: false }).delete).toBe(false);
    expect(remoteDeleteAllowed({ ...landed, clean: false }).delete).toBe(false);
    expect(remoteDeleteAllowed({ ...landed, branch: "main" }).delete).toBe(false);
    expect(remoteDeleteAllowed({ ...landed, branch: "development" }).delete).toBe(false);
    expect(remoteDeleteAllowed({ ...landed, branch: "lanes/integration" }).delete).toBe(false);
  });

  it("accepts push --delete of the task branch and refuses force and the base", () => {
    assertRemoteBranchDelete([
      "push",
      "https://example.test/repo.git",
      "--delete",
      "task/lin-ENG-9",
    ]);
    expect(() =>
      assertRemoteBranchDelete([
        "push",
        "--force",
        "https://example.test/repo.git",
        "--delete",
        "task/lin-ENG-9",
      ]),
    ).toThrow(/force-push/);
    expect(() =>
      assertRemoteBranchDelete(["push", "https://example.test/repo.git", "--delete", "main"]),
    ).toThrow(/target branch/);
  });
});
