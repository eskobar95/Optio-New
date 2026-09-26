import { describe, expect, it, afterEach } from "vitest";
import { createIntakeServer, signLinearBody } from "../src/index.js";
import { applyWorkflowEffects } from "../src/orchestrator/linear/apply.js";
import { LinearStatusMissingError } from "../src/orchestrator/linear/status.js";
import {
  openGithubPullRequest,
  reRequestGithubPullRequestReview,
} from "../src/orchestrator/github/pull-request.js";
import {
  CI_FAIL_ESCALATE_ENV,
  DEFAULT_CI_FAIL_ESCALATE_AFTER,
  blockingReviewFeedback,
  boardSetupPlan,
  consumeAgentStatusWrite,
  decideAgentAdvance,
  decideObservedMove,
  escalationComment,
  noteAgentStatusWrite,
  readBlindAlley,
  readCiFailEscalateAfter,
  resetAgentStatusWrites,
  reviewFailureKey,
} from "../src/orchestrator/linear/workflow.js";
import type { WorkflowPorts } from "../src/orchestrator/linear/apply.js";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const WHEN = "2026-09-26T15:00:00.000Z";

function advance(
  partial: Partial<Parameters<typeof decideAgentAdvance>[0]> & {
    action: Parameters<typeof decideAgentAdvance>[0]["action"];
  },
) {
  return decideAgentAdvance({
    ciFailureCount: 0,
    escalateAfter: DEFAULT_CI_FAIL_ESCALATE_AFTER,
    whenIso: WHEN,
    ...partial,
  });
}

function ports(overrides: Partial<WorkflowPorts> = {}): {
  calls: string[];
  ports: WorkflowPorts;
} {
  const calls: string[] = [];
  return {
    calls,
    ports: {
      openDraft: async () => {
        calls.push("draft");
      },
      markReady: async () => {
        calls.push("ready");
      },
      merge: async () => {
        calls.push("merge");
      },
      rereview: async (comment) => {
        calls.push(`rereview:${comment}`);
      },
      setStatus: async (status) => {
        calls.push(`status:${status}`);
      },
      comment: async (body) => {
        calls.push(`comment:${body}`);
      },
      revert: async (stateId) => {
        calls.push(`revert:${stateId}`);
      },
      escalationStatus: async () => "Needs Human",
      ...overrides,
    },
  };
}

describe("Linear workflow decisions", () => {
  afterEach(() => {
    resetAgentStatusWrites();
  });

  it("opens a draft on In Progress, undrafts on green Review, and merges to Done", () => {
    const start = advance({ action: "start" });
    expect(start.effects.map((effect) => effect.kind)).toEqual(["github.draft", "linear.status"]);
    expect(start.effects[1]).toMatchObject({ status: "In Progress" });

    const review = advance({ action: "review", ci: "green", ciFailureCount: 2 });
    expect(review.ok).toBe(true);
    expect(review.ciFailureCount).toBe(0);
    expect(review.effects.map((effect) => effect.kind)).toEqual(["github.ready", "linear.status"]);
    expect(review.effects[1]).toMatchObject({ status: "Review" });

    const merge = advance({ action: "merge", humanApproved: true });
    expect(merge.effects.map((effect) => effect.kind)).toEqual([
      "github.merge",
      "linear.status",
      "linear.status",
    ]);
    expect(merge.effects[1]).toMatchObject({ status: "Merge" });
    expect(merge.effects[2]).toMatchObject({ status: "Done" });
  });

  it("returns to In Progress with feedback when CI is red and keeps the pull request ready", () => {
    const decision = advance({ action: "review", ci: "red", ciFailureCount: 0 });
    expect(decision.ok).toBe(true);
    expect(decision.halt).toBe(false);
    expect(decision.reason).toBe("return_to_progress");
    expect(decision.ciFailureCount).toBe(1);
    expect(decision.effects.map((effect) => effect.kind)).toEqual([
      "linear.status",
      "linear.comment",
      "github.rereview",
    ]);
    expect(decision.effects[0]).toMatchObject({ status: "In Progress" });
    const comment = decision.effects[1];
    expect(comment?.kind).toBe("linear.comment");
    if (comment?.kind !== "linear.comment") return;
    expect(comment.body).toContain("Failed: GitHub checks red (tests, lint, or Actions)");
    expect(comment.body).toContain("Must fix: Make CI green (tests, lint, and Actions)");
    expect(comment.body).toContain("Attempt: 1/3");
    expect(decision.effects.some((effect) => effect.kind === "github.draft")).toBe(false);
    expect(decision.effects.some((effect) => effect.kind === "github.ready")).toBe(false);
  });

  it("returns to In Progress when review feedback is still open on green CI", () => {
    const decision = advance({
      action: "review",
      ci: "green",
      ciFailureCount: 1,
      reviewFeedback: "Rename the helper",
    });
    expect(decision.reason).toBe("return_to_progress");
    expect(decision.ciFailureCount).toBe(2);
    const comment = decision.effects.find((effect) => effect.kind === "linear.comment");
    expect(comment).toMatchObject({
      kind: "linear.comment",
      body: expect.stringContaining("Must fix: Rename the helper"),
    });
  });

  it("does not count the same commit and the same feedback twice", () => {
    const key = reviewFailureKey("abc123", "Rename the helper");
    const again = advance({
      action: "review",
      ci: "red",
      ciFailureCount: 1,
      reviewFeedback: "Rename the helper",
      failureKey: key,
      lastFailureKey: key,
    });
    expect(again.ok).toBe(false);
    expect(again.reason).toBe("ci_unchanged");
    expect(again.ciFailureCount).toBe(1);
    expect(again.effects).toEqual([]);
  });

  it("treats a later approval as clearing that reviewer's feedback", () => {
    expect(
      blockingReviewFeedback([
        { login: "ada", state: "CHANGES_REQUESTED", body: "Fix the gate" },
        { login: "ada", state: "APPROVED", body: "" },
      ]),
    ).toBeUndefined();
    expect(
      blockingReviewFeedback([
        { login: "ada", state: "CHANGES_REQUESTED", body: "Fix the gate" },
        { login: "bea", state: "COMMENTED", body: "Also rename the helper" },
      ]),
    ).toBe("ada: Fix the gate\nbea: Also rename the helper");
  });

  it("does not count a pending check as a failure", () => {
    const pending = advance({ action: "review", ci: "pending", ciFailureCount: 1 });
    expect(pending.reason).toBe("ci_pending");
    expect(pending.ciFailureCount).toBe(1);
    expect(pending.effects).toEqual([]);
  });

  it("escalates on the third CI failure with when, why, tried, and failed", () => {
    const decision = advance({ action: "review", ci: "red", ciFailureCount: 2 });
    expect(decision.halt).toBe(true);
    expect(decision.reason).toBe("ci_failures");
    expect(decision.ciFailureCount).toBe(3);
    expect(decision.effects).toEqual([
      {
        kind: "linear.escalate",
        comment: escalationComment({
          whenIso: WHEN,
          why: "Repeated CI failure (3/3)",
          tried: "In Progress → Review",
          failed: "GitHub checks red (tests, lint, or Actions)",
        }),
      },
    ]);
  });

  it("escalates a blind alley before the CI count is reached", () => {
    const decision = advance({
      action: "blind_alley",
      ciFailureCount: 0,
      blindAlley: {
        why: "The approach cannot satisfy the schema",
        tried: "Two rewrites of the parser",
        failed: "Both still drop the required field",
      },
    });
    expect(decision.halt).toBe(true);
    expect(decision.reason).toBe("blind_alley");
    expect(decision.ciFailureCount).toBe(0);
    const effect = decision.effects[0];
    expect(effect?.kind).toBe("linear.escalate");
    if (effect?.kind !== "linear.escalate") return;
    expect(effect.comment).toContain("When: 2026-09-26T15:00:00.000Z");
    expect(effect.comment).toContain("Why: The approach cannot satisfy the schema");
    expect(effect.comment).toContain("Tried: Two rewrites of the parser");
    expect(effect.comment).toContain("Failed: Both still drop the required field");
  });

  it("reverts a human move to Review and does not undraft", () => {
    const human = decideObservedMove({
      toStatus: "Review",
      actor: "human",
      fromStateId: "state-in-progress",
    });
    expect(human.ok).toBe(false);
    expect(human.reason).toBe("human_override");
    expect(human.effects).toEqual([{ kind: "linear.revert", stateId: "state-in-progress" }]);

    const completed = decideObservedMove({
      toStatus: "Completed",
      actor: "human",
      fromStateId: "state-review",
    });
    expect(completed.effects).toEqual([{ kind: "linear.revert", stateId: "state-review" }]);

    const agent = decideObservedMove({ toStatus: "Review", actor: "agent", fromStateId: "x" });
    expect(agent.ok).toBe(true);
    expect(agent.effects).toEqual([]);
  });

  it("uses 3 as the default escalate threshold and honors a configured integer", () => {
    expect(readCiFailEscalateAfter({})).toBe(3);
    expect(readCiFailEscalateAfter({ [CI_FAIL_ESCALATE_ENV]: "5" })).toBe(5);
    expect(readCiFailEscalateAfter({ [CI_FAIL_ESCALATE_ENV]: "0" })).toBe(3);
    expect(readCiFailEscalateAfter({ [CI_FAIL_ESCALATE_ENV]: "nope" })).toBe(3);
    const fourth = advance({
      action: "review",
      ci: "red",
      ciFailureCount: 3,
      escalateAfter: 5,
    });
    expect(fourth.halt).toBe(false);
    expect(fourth.ciFailureCount).toBe(4);
    const fifth = advance({
      action: "review",
      ci: "red",
      ciFailureCount: 4,
      escalateAfter: 5,
    });
    expect(fifth.halt).toBe(true);
    expect(fifth.ciFailureCount).toBe(5);
  });

  it("does not create Linear columns", () => {
    expect(boardSetupPlan().createColumns).toBe(false);
    expect(boardSetupPlan().escalationPreferred).toBe("Needs Human");
    expect(boardSetupPlan().escalationFallback).toBe("In Progress");
  });

  it("reads the blind-alley marker and ignores a partial line", () => {
    expect(readBlindAlley("noise\nLINEAR_BLIND_ALLEY why: stuck | tried: a | failed: b\n")).toEqual(
      { why: "stuck", tried: "a", failed: "b" },
    );
    expect(readBlindAlley("LINEAR_BLIND_ALLEY why: only")).toBeUndefined();
  });

  it("treats an agent status write as the agent's own move", () => {
    noteAgentStatusWrite("issue-1", "Review", 1_000);
    expect(consumeAgentStatusWrite("issue-1", "Review", 1_500)).toBe(true);
    expect(consumeAgentStatusWrite("issue-1", "Review", 1_500)).toBe(false);
    noteAgentStatusWrite("issue-1", "Review", 1_000);
    expect(consumeAgentStatusWrite("issue-1", "Review", 1_000 + 60_000)).toBe(false);
  });
});

describe("Linear workflow effects", () => {
  it("applies draft then status, and a red gate returns to In Progress without drafting", async () => {
    const happy = ports();
    await applyWorkflowEffects(advance({ action: "start" }), happy.ports);
    expect(happy.calls).toEqual(["draft", "status:In Progress"]);

    const blocked = ports();
    await applyWorkflowEffects(advance({ action: "review", ci: "red" }), blocked.ports);
    expect(blocked.calls[0]).toBe("status:In Progress");
    expect(blocked.calls[1]).toContain("Review feedback");
    expect(blocked.calls[2]).toContain("rereview:");
    expect(blocked.calls.some((call) => call === "draft" || call === "ready")).toBe(false);
  });

  it("moves to Needs Human and comments, or falls back to In Progress", async () => {
    const preferred = ports();
    const decision = advance({ action: "review", ci: "red", ciFailureCount: 2 });
    await applyWorkflowEffects(decision, preferred.ports);
    expect(preferred.calls[0]).toBe("status:Needs Human");
    expect(preferred.calls[1]).toContain("Human help needed");
    expect(preferred.calls.some((call) => call === "ready")).toBe(false);

    const fallback = ports({
      escalationStatus: async () => "Needs Human",
      setStatus: async (status) => {
        fallback.calls.push(`status:${status}`);
        if (status === "Needs Human") throw new LinearStatusMissingError(status);
      },
    });
    await applyWorkflowEffects(decision, fallback.ports);
    expect(fallback.calls).toContain("status:In Progress");
    expect(fallback.calls.some((call) => call.startsWith("comment:"))).toBe(true);
  });

  it("sends draft:true when opening the pull request", async () => {
    let body = "";
    await openGithubPullRequest({
      token: "test-github-token",
      owner: "acme",
      repo: "widgets",
      title: "Ship",
      head: "task/lin-FIN-1",
      base: "main",
      body: "notes",
      draft: true,
      fetchImpl: async (_url, init) => {
        body = typeof init?.body === "string" ? init.body : "";
        return new Response(
          JSON.stringify({ html_url: "https://github.com/acme/widgets/pull/9", number: 9 }),
          { status: 201 },
        );
      },
    });
    expect(JSON.parse(body)).toMatchObject({ draft: true, base: "main" });
  });

  it("re-requests review and comments without converting the pull request to a draft", async () => {
    const bodies: { url: string; body: string }[] = [];
    await reRequestGithubPullRequestReview({
      token: "test-github-token",
      owner: "acme",
      repo: "widgets",
      number: 9,
      reviewers: ["ada"],
      comment: "Review feedback\nFailed: checks red\nMust fix: tests",
      fetchImpl: async (url, init) => {
        bodies.push({
          url: String(url),
          body: typeof init?.body === "string" ? init.body : "",
        });
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
      },
    });
    expect(bodies.map((call) => call.url)).toEqual([
      "https://api.github.com/repos/acme/widgets/pulls/9/requested_reviewers",
      "https://api.github.com/repos/acme/widgets/issues/9/comments",
    ]);
    for (const call of bodies) {
      expect(call.body).not.toContain("draft");
    }
    expect(JSON.parse(bodies[0]?.body ?? "{}")).toEqual({ reviewers: ["ada"] });
    expect(JSON.parse(bodies[1]?.body ?? "{}").body).toContain("Must fix: tests");
  });
});

describe("Linear webhook gate", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    resetAgentStatusWrites();
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
    );
  });

  it("reverts a human Review move and still comments queued", async () => {
    const secret = "linear-webhook-test-secret";
    const issueId = "2174add1-f7c8-44e3-bbf3-2d60b5ea8bc9";
    const graphql: { query: string; variables: Record<string, string> }[] = [];
    const server = createIntakeServer({
      linearWebhookSecret: secret,
      linearApiKey: "lin_api_testkey12345678",
      linearDefaultRepoId: "findjobabroad",
      repoCatalog: {
        defaultRepoId: "findjobabroad",
        repos: [
          {
            repoId: "findjobabroad",
            cloneUrl: "https://github.com/kit/find-job-abroad.git",
            localPath: "/opt/findjobabroad",
            defaultBranch: "main",
            worktreeRoot: "/wt/fja",
          },
        ],
      },
      linearFetch: async (_url, init) => {
        const parsed = JSON.parse(String(init?.body)) as {
          query: string;
          variables: Record<string, string>;
        };
        graphql.push(parsed);
        if (parsed.query.includes("commentCreate")) {
          return new Response(JSON.stringify({ data: { commentCreate: { success: true } } }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), {
          status: 200,
        });
      },
      enqueuer: { async add() {} },
    });
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    const payload = JSON.stringify({
      action: "update",
      type: "Issue",
      webhookTimestamp: Date.now(),
      data: {
        id: issueId,
        identifier: "FIN-12",
        title: "Ship intake",
        state: { id: "state-review", name: "Review" },
        team: { key: "FIN" },
      },
      updatedFrom: { stateId: "state-in-progress" },
    });
    const raw = Buffer.from(payload);
    const response = await fetch(`http://127.0.0.1:${address.port}/webhooks/linear`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": signLinearBody(secret, raw),
      },
      body: raw,
    });
    expect(response.status).toBe(200);
    const comment = graphql.find((call) => call.query.includes("commentCreate"));
    const revert = graphql.find((call) => call.query.includes("issueUpdate"));
    expect(comment?.variables.body).toBe("queued");
    expect(revert?.variables).toEqual({ id: issueId, stateId: "state-in-progress" });
    expect(graphql.some((call) => call.query.includes("issueCreate"))).toBe(false);
  });
});
