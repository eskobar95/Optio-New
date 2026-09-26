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

const emptyWorkflows = { total_count: 0, workflow_runs: [] };

function ciFetch(payload: {
  status: unknown;
  statusCode?: number;
  checks?: unknown;
  checksStatus?: number;
  workflows?: unknown;
  onUrl?: (href: string) => void;
}): typeof fetch {
  return async (url) => {
    const href = String(url);
    payload.onUrl?.(href);
    if (href.includes("/commits/") && href.includes("/status")) {
      return jsonResponse(payload.statusCode ?? 200, payload.status);
    }
    if (href.includes("/actions/runs")) {
      return jsonResponse(200, payload.workflows ?? emptyWorkflows);
    }
    if (href.includes("/check-runs")) {
      return jsonResponse(
        payload.checksStatus ?? 200,
        payload.checks ?? { total_count: 0, check_runs: [] },
      );
    }
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

  it("treats a green Actions workflow run as success when check runs return 403", async () => {
    const urls: string[] = [];
    const report = await readCommitStatusReport({
      ...statusInput,
      fetchImpl: ciFetch({
        status: { state: "pending", statuses: [], total_count: 0 },
        checksStatus: 403,
        checks: { message: "Resource not accessible by personal access token" },
        workflows: {
          total_count: 1,
          workflow_runs: [
            {
              id: 11,
              name: "verify",
              head_sha: "abc123",
              status: "completed",
              conclusion: "success",
            },
          ],
        },
        onUrl: (href) => urls.push(href),
      }),
    });
    expect(report).toEqual({ state: "success", failedChecks: [] });
    expect(
      urls.some((href) => href.includes("/actions/runs") && href.includes("head_sha=abc123")),
    ).toBe(true);
  });

  it("stays pending while an Actions workflow run is in progress and check runs are unavailable", async () => {
    const report = await readCommitStatusReport({
      ...statusInput,
      fetchImpl: ciFetch({
        status: { state: "pending", statuses: [], total_count: 0 },
        checksStatus: 403,
        checks: { message: "Resource not accessible by personal access token" },
        workflows: {
          total_count: 1,
          workflow_runs: [
            { id: 12, name: "verify", head_sha: "abc123", status: "in_progress", conclusion: null },
          ],
        },
      }),
    });
    expect(report).toEqual({ state: "pending", failedChecks: [] });
  });

  it("fails when an Actions workflow run failed and check runs are unavailable", async () => {
    const report = await readCommitStatusReport({
      ...statusInput,
      fetchImpl: ciFetch({
        status: { state: "pending", statuses: [], total_count: 0 },
        checksStatus: 403,
        checks: { message: "Resource not accessible by personal access token" },
        workflows: {
          total_count: 1,
          workflow_runs: [
            {
              id: 13,
              name: "verify",
              head_sha: "abc123",
              status: "completed",
              conclusion: "failure",
            },
          ],
        },
      }),
    });
    expect(report).toEqual({ state: "failure", failedChecks: ["verify"] });
  });

  it("fails when an Actions workflow run was cancelled and check runs are unavailable", async () => {
    const report = await readCommitStatusReport({
      ...statusInput,
      fetchImpl: ciFetch({
        status: { state: "pending", statuses: [], total_count: 0 },
        checksStatus: 403,
        checks: { message: "Resource not accessible by personal access token" },
        workflows: {
          total_count: 1,
          workflow_runs: [
            {
              id: 14,
              name: "verify",
              head_sha: "abc123",
              status: "completed",
              conclusion: "cancelled",
            },
          ],
        },
      }),
    });
    expect(report).toEqual({ state: "failure", failedChecks: ["verify"] });
  });

  it("treats a green Actions workflow run as success when status and check runs both return 403", async () => {
    const report = await readCommitStatusReport({
      ...statusInput,
      fetchImpl: ciFetch({
        status: { message: "Resource not accessible by personal access token" },
        statusCode: 403,
        checksStatus: 403,
        checks: { message: "Resource not accessible by personal access token" },
        workflows: {
          total_count: 1,
          workflow_runs: [
            {
              id: 15,
              name: "verify",
              head_sha: "abc123",
              status: "completed",
              conclusion: "success",
            },
          ],
        },
      }),
    });
    expect(report).toEqual({ state: "success", failedChecks: [] });
  });

  it("keeps a green commit status when check runs return 403 and no workflow ran", async () => {
    const report = await readCommitStatusReport({
      ...statusInput,
      fetchImpl: ciFetch({
        status: {
          state: "success",
          total_count: 1,
          statuses: [{ context: "ci/lint", state: "success" }],
        },
        checksStatus: 403,
        checks: { message: "Resource not accessible by personal access token" },
        workflows: emptyWorkflows,
      }),
    });
    expect(report).toEqual({ state: "success", failedChecks: [] });
  });
});
