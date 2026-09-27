import { describe, expect, it } from "vitest";
import {
  findOpenGithubPullRequest,
  markGithubPullRequestReady,
  openGithubPullRequest,
  readCommitStatusReport,
  requestGithubPullRequestReviewers,
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

describe("markGithubPullRequestReady", () => {
  const readyInput = {
    token: "test-github-token",
    owner: "acme",
    repo: "widgets",
    number: 69,
  };

  it("undrafts with markPullRequestReadyForReview and does not PATCH draft", async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    await markGithubPullRequestReady({
      ...readyInput,
      fetchImpl: async (url, init) => {
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? init.body : undefined;
        calls.push({ url: String(url), method, body });
        if (method === "GET") {
          return jsonResponse(200, { draft: true, node_id: "PR_kwDO123" });
        }
        return jsonResponse(200, {
          data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } },
        });
      },
    });
    expect(calls.map((call) => call.method)).toEqual(["GET", "POST"]);
    expect(calls[1]?.url).toBe("https://api.github.com/graphql");
    expect(calls[1]?.body).toContain("markPullRequestReadyForReview");
    expect(calls[1]?.body).toContain("PR_kwDO123");
    expect(
      calls.some((call) => call.method === "PATCH" || call.body?.includes('"draft":false')),
    ).toBe(false);
  });

  it("does nothing when the pull request is already ready", async () => {
    const methods: string[] = [];
    await markGithubPullRequestReady({
      ...readyInput,
      fetchImpl: async (_url, init) => {
        methods.push(init?.method ?? "GET");
        return jsonResponse(200, { draft: false, node_id: "PR_kwDO123" });
      },
    });
    expect(methods).toEqual(["GET"]);
  });

  it("fails when GraphQL leaves the pull request a draft", async () => {
    await expect(
      markGithubPullRequestReady({
        ...readyInput,
        fetchImpl: async (url, init) => {
          const method = init?.method ?? "GET";
          if (method === "GET") return jsonResponse(200, { draft: true, node_id: "PR_kwDO123" });
          return jsonResponse(200, {
            data: { markPullRequestReadyForReview: { pullRequest: { isDraft: true } } },
            errors: [{ message: "draft field ignored" }],
          });
        },
      }),
    ).rejects.toThrow(/still a draft|draft field ignored|undraft failed/);
  });

  it("treats a follow-up read of draft false as success", async () => {
    let reads = 0;
    await markGithubPullRequestReady({
      ...readyInput,
      fetchImpl: async (_url, init) => {
        const method = init?.method ?? "GET";
        if (method === "GET") {
          reads += 1;
          return jsonResponse(200, { draft: reads === 1, node_id: "PR_kwDO123" });
        }
        return jsonResponse(200, { errors: [{ message: "already ready for review" }] });
      },
    });
    expect(reads).toBe(2);
  });

  it("requests configured reviewers and ignores an empty list", async () => {
    const bodies: string[] = [];
    await requestGithubPullRequestReviewers({
      ...readyInput,
      reviewers: ["hannes-bot", "hannes-bot", " "],
      fetchImpl: async (_url, init) => {
        bodies.push(typeof init?.body === "string" ? init.body : "");
        return jsonResponse(201, { ok: true });
      },
    });
    expect(JSON.parse(bodies[0] ?? "{}")).toEqual({ reviewers: ["hannes-bot"] });
    const calls: string[] = [];
    await requestGithubPullRequestReviewers({
      ...readyInput,
      reviewers: [],
      fetchImpl: async () => {
        calls.push("called");
        return jsonResponse(500, {});
      },
    });
    expect(calls).toEqual([]);
  });
});
