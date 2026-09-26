import { describe, expect, it } from "vitest";
import { commentQueuedOnIssue, LINEAR_GRAPHQL_URL } from "../src/orchestrator/linear/comment.js";
import { assertLinearWrite } from "../src/orchestrator/linear/policy.js";

const API_KEY = "lin_api_testkey12345678";

describe("Linear comment client", () => {
  it("posts commentCreate with body queued and no other write", async () => {
    const calls: { url: string; body: string; authorization: string }[] = [];
    await commentQueuedOnIssue({
      apiKey: API_KEY,
      issueId: "2174add1-f7c8-44e3-bbf3-2d60b5ea8bc9",
      fetchImpl: async (url, init) => {
        const headers = new Headers(init?.headers);
        calls.push({
          url: String(url),
          body: typeof init?.body === "string" ? init.body : "",
          authorization: headers.get("authorization") ?? "",
        });
        return new Response(JSON.stringify({ data: { commentCreate: { success: true } } }), {
          status: 200,
        });
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(LINEAR_GRAPHQL_URL);
    expect(calls[0]?.authorization).toBe(API_KEY);
    const posted = JSON.parse(calls[0]?.body ?? "{}") as {
      query: string;
      variables: { issueId: string; body: string };
    };
    expect(posted.query).toContain("commentCreate");
    expect(posted.query).not.toContain("issueCreate");
    expect(posted.query).not.toContain("issueDelete");
    expect(posted.query).not.toContain("issueArchive");
    expect(posted.variables).toEqual({
      issueId: "2174add1-f7c8-44e3-bbf3-2d60b5ea8bc9",
      body: "queued",
    });
  });

  it("allows commentCreate and status-only issueUpdate", () => {
    expect(() => assertLinearWrite("commentCreate")).not.toThrow();
    expect(() => assertLinearWrite("issueUpdate", ["stateId"])).not.toThrow();
    expect(() => assertLinearWrite("issueUpdate", ["title"])).toThrow(/stateId only/);
    expect(() => assertLinearWrite("issueCreate")).toThrow(/not allowed/);
    expect(() => assertLinearWrite("issueDelete")).toThrow(/not allowed/);
    expect(() => assertLinearWrite("issueArchive")).toThrow(/not allowed/);
  });
});
