import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const script = path.resolve("scripts/update-status.sh");

function run(out: string, extra: Record<string, string> = {}): string {
  return execFileSync("bash", [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      STATUS_OUT: out,
      STATUS_USE_FIXTURES: "1",
      GITHUB_REPOSITORY: "eskobar95/Optio-New",
      STATUS_CI_CONCLUSION: "success",
      STATUS_ISSUES_MD: "- #15 docs/status.md automation (P2, documentation)",
      STATUS_NOW: "2026-01-01 00:00 UTC",
      ...extra,
    },
  });
}

describe("update-status.sh", () => {
  it("writes the CI badge, open issues, and manual refresh docs", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "optio-status-"));
    const out = path.join(dir, "status.md");
    const stdout = run(out);

    expect(stdout).toContain(`Updated ${out}`);
    const text = readFileSync(out, "utf8");
    expect(text).toContain(
      "https://github.com/eskobar95/Optio-New/actions/workflows/ci.yml/badge.svg",
    );
    expect(text).toContain("Latest conclusion: **success**");
    expect(text).toContain("Open: 1.");
    expect(text).toContain("- #15 docs/status.md automation (P2, documentation)");
    expect(text).toContain("npm run status");
    expect(text).toContain(".github/workflows/status.yml");
    expect(text).toContain("Last refreshed: 2026-01-01 00:00 UTC");
  });

  it("is idempotent when the CI conclusion and issues are unchanged", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "optio-status-"));
    const out = path.join(dir, "status.md");
    run(out, { STATUS_NOW: "2026-01-01 00:00 UTC" });
    const first = readFileSync(out, "utf8");

    const stdout = run(out, { STATUS_NOW: "2026-09-26 12:00 UTC" });
    expect(stdout).toContain(`Unchanged ${out}`);
    expect(readFileSync(out, "utf8")).toBe(first);
  });

  it("rewrites when the open-issue list or CI conclusion changes", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "optio-status-"));
    const out = path.join(dir, "status.md");
    run(out, { STATUS_NOW: "2026-01-01 00:00 UTC" });

    const stdout = run(out, {
      STATUS_NOW: "2026-09-26 12:00 UTC",
      STATUS_CI_CONCLUSION: "failure",
      STATUS_ISSUES_MD:
        "- #23 Mac local verify (good first issue)\n- #15 docs/status.md automation (P2)",
    });

    expect(stdout).toContain(`Updated ${out}`);
    const text = readFileSync(out, "utf8");
    expect(text).toContain("Last refreshed: 2026-09-26 12:00 UTC");
    expect(text).toContain("Latest conclusion: **failure**");
    expect(text).toContain("Open: 2.");
    expect(text).toContain("- #23 Mac local verify (good first issue)");
    expect(text).not.toContain("2026-01-01 00:00 UTC");
  });

  it("records an empty issue list", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "optio-status-"));
    const out = path.join(dir, "status.md");
    run(out, { STATUS_ISSUES_MD: "" });
    const text = readFileSync(out, "utf8");
    expect(text).toContain("Open: 0.");
    expect(text).toContain("- (no open issues)");
  });
});
