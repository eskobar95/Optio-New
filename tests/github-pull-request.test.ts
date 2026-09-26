import { describe, expect, it } from "vitest";
import {
  findOpenGithubPullRequest,
  openGithubPullRequest,
  readCommitStatusReport,
} from "../src/orchestrator/github/pull-request.js";

const input = {
  token: "test-github-token",
  owner: "acme",
  repo: "widgets",
  title: "Ship graph",
  head: "task/t-1",
  base: "development",
  body: "notes",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GitHub pull request idempotency", () => {
  it("returns the open pull request when GitHub answers 422", async () => {
    const calls: string[] = [];
    const opened = await openGithubPullRequest({
      ...input,
      fetchImpl: async (url, init) => {
        const method = init?.method ?? "GET";
        calls.push(method);
        if (method === "POST") return jsonResponse(422, { message: "already exists" });
        return jsonResponse(200, [
          {
            html_url: "https://github.com/acme/widgets/pull/4",
            number: 4,
            head: { ref: "task/t-1" },
          },
        ]);
      },
    });
    expect(opened).toEqual({ url: "https://github.com/acme/widgets/pull/4", number: 4 });
    expect(calls).toEqual(["POST", "GET"]);
    await expect(
      findOpenGithubPullRequest({ ...input, fetchImpl: async () => jsonResponse(200, []) }),
    ).resolves.toBeUndefined();
  });
});

const statusInput = {
  token: "test-github-token",
  owner: "acme",
  repo: "widgets",
  sha: "abc123",
};

function ciFetch(payload: { status: unknown; checks: unknown }): typeof fetch {
  return async (url) => {
    const href = String(url);
    if (href.includes("/commits/") && href.includes("/status")) {
      return jsonResponse(200, payload.status);
    }
    if (href.includes("/check-runs")) return jsonResponse(200, payload.checks);
    return jsonResponse(500, { message: href });
  };
}

describe("readCommitStatusReport", () => {
  it("treats green check runs as success when commit statuses have no contexts", async () => {
    const report = await readCommitStatusReport({
      ...statusInput,
      fetchImpl: ciFetch({
        status: { state: "pending", statuses: [], total_count: 0 },
        checks: {
          total_count: 2,
          check_runs: [
            { name: "verify", status: "completed", conclusion: "success" },
            { name: "GitGuardian Security Checks", status: "completed", conclusion: "success" },
          ],
        },
      }),
    });
    expect(report).toEqual({ state: "success", failedChecks: [] });
  });

  it("stays pending while a check run is still in progress", async () => {
    const report = await readCommitStatusReport({
      ...statusInput,
      fetchImpl: ciFetch({
        status: { state: "pending", statuses: [], total_count: 0 },
        checks: {
          total_count: 1,
          check_runs: [{ name: "verify", status: "in_progress", conclusion: null }],
        },
      }),
    });
    expect(report).toEqual({ state: "pending", failedChecks: [] });
  });

  it("fails when a check run failed and commit statuses have no contexts", async () => {
    const report = await readCommitStatusReport({
      ...statusInput,
      fetchImpl: ciFetch({
        status: { state: "pending", statuses: [], total_count: 0 },
        checks: {
          total_count: 1,
          check_runs: [{ name: "verify", status: "completed", conclusion: "failure" }],
        },
      }),
    });
    expect(report).toEqual({ state: "failure", failedChecks: ["verify"] });
  });

  it("names a failed commit status context when there are no check runs", async () => {
    const report = await readCommitStatusReport({
      ...statusInput,
      fetchImpl: ciFetch({
        status: {
          state: "failure",
          statuses: [{ context: "ci/lint", state: "failure" }],
        },
        checks: { total_count: 0, check_runs: [] },
      }),
    });
    expect(report).toEqual({ state: "failure", failedChecks: ["ci/lint"] });
  });

  it("stays success when commit statuses are green and there are no check runs", async () => {
    const report = await readCommitStatusReport({
      ...statusInput,
      fetchImpl: ciFetch({
        status: {
          state: "success",
          total_count: 1,
          statuses: [{ context: "ci/lint", state: "success" }],
        },
        checks: { total_count: 0, check_runs: [] },
      }),
    });
    expect(report).toEqual({ state: "success", failedChecks: [] });
  });

  it("stays pending when a green status context still has a check run in progress", async () => {
    const report = await readCommitStatusReport({
      ...statusInput,
      fetchImpl: ciFetch({
        status: {
          state: "success",
          statuses: [{ context: "ci/lint", state: "success" }],
        },
        checks: {
          total_count: 1,
          check_runs: [{ name: "verify", status: "queued", conclusion: null }],
        },
      }),
    });
    expect(report).toEqual({ state: "pending", failedChecks: [] });
  });

  it("fails when a check run failed even if commit statuses are green", async () => {
    const report = await readCommitStatusReport({
      ...statusInput,
      fetchImpl: ciFetch({
        status: {
          state: "success",
          statuses: [{ context: "ci/lint", state: "success" }],
        },
        checks: {
          total_count: 1,
          check_runs: [{ name: "verify", status: "completed", conclusion: "failure" }],
        },
      }),
    });
    expect(report).toEqual({ state: "failure", failedChecks: ["verify"] });
  });
});
