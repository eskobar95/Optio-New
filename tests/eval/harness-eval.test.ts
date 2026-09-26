import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadEvalFixtures,
  renderEvalReport,
  runHarnessEval,
  writeEvalReport,
  type EvalFixture,
} from "../../src/index.js";

const FIXTURES = "tests/eval/fixtures";
const CURSOR_KEY = "eval-cursor-key";
const GITHUB_TOKEN = "eval-github-token";

describe("harness eval", () => {
  it("runs mock fixtures from intake through a mocked pull request and writes a pass/fail report", async () => {
    const fixtures = await loadEvalFixtures(FIXTURES);
    expect(fixtures.map((fixture) => fixture.id)).toEqual([
      "budget-cap",
      "cheap-cursor",
      "happy-path-open-pr",
      "missing-credentials",
    ]);

    const mock = fixtures.filter((fixture) => fixture.mode === "mock");
    const report = await runHarnessEval({ fixtures: mock, mode: "mock" });
    const artifact = await writeEvalReport(report, "eval-reports");
    const json = await readFile(artifact.jsonPath, "utf8");
    const text = await readFile(artifact.textPath, "utf8");

    expect(report.ok).toBe(true);
    expect(report.failed).toBe(0);
    expect(report.passed).toBe(3);
    expect(report.cases.map((row) => [row.id, row.status])).toEqual([
      ["happy-path-open-pr", "pass"],
      ["missing-credentials", "pass"],
      ["budget-cap", "pass"],
    ]);

    const happy = report.cases.find((row) => row.id === "happy-path-open-pr");
    const missing = report.cases.find((row) => row.id === "missing-credentials");
    const budget = report.cases.find((row) => row.id === "budget-cap");
    expect(happy?.actual).toContain("https://github.com/acme/widgets/pull/41");
    expect(happy?.actual).toContain("pr_opened");
    expect(missing?.actual).toContain("missing_credentials");
    expect(missing?.actual).toContain("open_pr_calls=0");
    expect(budget?.actual).toContain("token_budget");
    expect(budget?.actual).toContain("open_pr_calls=0");
    expect(text).toBe(renderEvalReport(report));
    expect(text).toContain("PASS happy-path-open-pr");
    expect(text).toContain("PASS missing-credentials");
    expect(text).toContain("PASS budget-cap");
    expect(json).toContain('"status": "pass"');
    expect(json).not.toContain(CURSOR_KEY);
    expect(json).not.toContain(GITHUB_TOKEN);
    expect(text).not.toContain(CURSOR_KEY);
    expect(text).not.toContain(GITHUB_TOKEN);
  });

  it("marks a case fail when the factory outcome disagrees with the fixture", async () => {
    const [happy] = await loadEvalFixtures(FIXTURES, { ids: ["happy-path-open-pr"] });
    if (!happy) throw new Error("missing happy-path fixture");
    const broken: EvalFixture = {
      ...happy,
      id: "happy-path-mismatch",
      expect: { ...happy.expect, open_pr_calls: 5 },
    };
    const dir = mkdtempSync(join(tmpdir(), "harness-eval-"));
    const report = await runHarnessEval({ fixtures: [broken], mode: "mock" });
    const artifact = await writeEvalReport(report, dir);
    const text = await readFile(artifact.textPath, "utf8");

    expect(report.ok).toBe(false);
    expect(report.failed).toBe(1);
    expect(report.cases[0]?.status).toBe("fail");
    expect(report.cases[0]?.expected).toContain("open_pr_calls=5");
    expect(report.cases[0]?.actual).toContain("open_pr_calls=1");
    expect(text).toContain("FAIL happy-path-mismatch");
  });

  it("keeps the live Cursor fixture out of the mock suite", async () => {
    const fixtures = await loadEvalFixtures(FIXTURES, { mode: "mock" });
    expect(fixtures.map((fixture) => fixture.id)).not.toContain("cheap-cursor");
  });

  it.skipIf(process.env.HARNESS_EVAL_LIVE !== "1")(
    "runs the cheap Cursor fixture and still mocks the pull request",
    async () => {
      const fixtures = await loadEvalFixtures(FIXTURES, { ids: ["cheap-cursor"] });
      const report = await runHarnessEval({ fixtures, mode: "live" });
      await writeEvalReport(report, "eval-reports");
      expect(report.cases.map((row) => [row.id, row.status])).toEqual([["cheap-cursor", "pass"]]);
      expect(report.ok).toBe(true);
    },
  );
});
