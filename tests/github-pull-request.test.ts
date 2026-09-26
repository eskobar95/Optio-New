import { describe, expect, it } from "vitest";
import {
  findOpenGithubPullRequest,
  openGithubPullRequest,
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
