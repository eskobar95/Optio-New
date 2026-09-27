import { describe, expect, it } from "vitest";
import {
  REVIEW_GITHUB_LOGINS_ENV,
  formatOptioReviewComment,
  optioReviewPosted,
  readReviewGithubLogins,
  reviewSpecialistsForPaths,
} from "../src/orchestrator/linear/review-entry.js";

describe("review entry config", () => {
  it("reads comma-separated reviewer logins and has no default account", () => {
    expect(readReviewGithubLogins({})).toEqual([]);
    expect(readReviewGithubLogins({ [REVIEW_GITHUB_LOGINS_ENV]: "  " })).toEqual([]);
    expect(
      readReviewGithubLogins({ [REVIEW_GITHUB_LOGINS_ENV]: "hannes-bot, ada, hannes-bot" }),
    ).toEqual(["hannes-bot", "ada"]);
  });

  it("selects specialists from the diff and skips unrelated files", () => {
    expect(
      reviewSpecialistsForPaths([
        "src/app.ts",
        "state/migrations/001.sql",
        "deploy/Caddyfile",
        "apps/web/App.tsx",
        "docs/linear-workflow-spec.md",
      ]),
    ).toEqual([
      "specialists/back-end",
      "specialists/database",
      "specialists/devops",
      "specialists/front-end",
    ]);
    expect(reviewSpecialistsForPaths(["README.md"])).toEqual([]);
  });

  it("marks one review comment per head sha", () => {
    const comment = formatOptioReviewComment({
      sha: "abc123",
      reviewers: ["hannes-bot"],
      specialists: ["specialists/back-end"],
      body: "Standards: pass",
    });
    expect(comment).toContain("<!-- optio-review sha:abc123 -->");
    expect(comment).toContain("[optio-review]");
    expect(comment).toContain("skills/code-review");
    expect(comment).toContain("hannes-bot");
    expect(optioReviewPosted([comment], "abc123")).toBe(true);
    expect(optioReviewPosted([comment], "def456")).toBe(false);
    expect(optioReviewPosted(["a human note"], "abc123")).toBe(false);
  });
});
