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

function commentBodies(decision: {
  effects: readonly { kind: string; body?: string }[];
}): string[] {
  return decision.effects.flatMap((effect) =>
    effect.kind === "linear.comment" && typeof effect.body === "string" ? [effect.body] : [],
  );
}

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
      requestReviewers: async () => {
        calls.push("request_reviewers");
      },
      dispatchReview: async () => {
        calls.push("dispatch_review");
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
    expect(start.effects.map((effect) => effect.kind)).toEqual([
      "github.draft",
      "linear.status",
      "linear.comment",
    ]);
    expect(start.effects[1]).toMatchObject({ status: "In Progress" });
    expect(start.effects[2]).toMatchObject({
      kind: "linear.comment",
      body: expect.stringContaining("[status]\nStatus: In Progress\nTrigger: agent"),
    });

    const review = advance({ action: "review", ci: "green", ciFailureCount: 2 });
    expect(review.ok).toBe(true);
    expect(review.ciFailureCount).toBe(0);
    expect(review.effects.map((effect) => effect.kind)).toEqual([
      "github.ready",
      "github.request_reviewers",
      "github.dispatch_review",
      "linear.status",
      "linear.comment",
      "linear.comment",
    ]);
    expect(review.effects[3]).toMatchObject({ status: "Review" });
    expect(commentBodies(review)).toEqual([
      expect.stringContaining("[status]\nStatus: Review\nTrigger: ci"),
      expect.stringContaining("[ci]\nResult: green\nAttempt: 0/3"),
    ]);

    const merge = advance({ action: "merge", humanApproved: true });
    expect(merge.effects.map((effect) => effect.kind)).toEqual([
      "github.merge",
      "linear.status",
      "linear.comment",
      "linear.status",
      "linear.comment",
    ]);
    expect(merge.effects[1]).toMatchObject({ status: "Merge" });
    expect(merge.effects[3]).toMatchObject({ status: "Done" });
    expect(commentBodies(merge).join("\n")).toContain("Trigger: agent");

    const waiting = advance({ action: "merge", ci: "green", humanApproved: false });
    expect(waiting.reason).toBe("awaiting_approval");
    expect(waiting.ok).toBe(false);
    expect(waiting.effects.map((effect) => effect.kind)).toEqual([
      "github.ready",
      "github.request_reviewers",
      "github.dispatch_review",
      "linear.status",
      "linear.comment",
      "linear.comment",
    ]);
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
      "linear.comment",
      "linear.comment",
      "github.rereview",
    ]);
    expect(decision.effects[0]).toMatchObject({ status: "In Progress" });
    const bodies = commentBodies(decision);
    expect(bodies[0]).toContain("[status]\nStatus: In Progress\nTrigger: ci");
    expect(bodies[1]).toContain("[review]");
    expect(bodies[1]).toContain("Failed: GitHub checks red (tests, lint, or Actions)");
    expect(bodies[1]).toContain("Must fix: Make CI green (tests, lint, and Actions)");
    expect(bodies[1]).toContain("Attempt: 1/3");
    expect(bodies[2]).toContain("[ci]\nResult: red");
    expect(bodies[2]).toContain("Failed checks: combined status");
    expect(bodies[2]).toContain("Attempt: 1/3");
    expect(decision.effects.some((effect) => effect.kind === "github.draft")).toBe(false);
    expect(decision.effects.some((effect) => effect.kind === "github.ready")).toBe(false);
    expect(decision.effects.some((effect) => effect.kind === "github.request_reviewers")).toBe(
      false,
    );
    expect(decision.effects.some((effect) => effect.kind === "github.dispatch_review")).toBe(false);
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
    expect(commentBodies(decision).join("\n")).toContain("[review]");
    expect(commentBodies(decision).join("\n")).toContain("Must fix: Rename the helper");
    expect(commentBodies(decision).join("\n")).toContain("Trigger: review");
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
    expect(
      blockingReviewFeedback([
        {
          login: "optio",
          state: "COMMENTED",
          body: "<!-- optio-review sha:abc -->\n[optio-review]\npass",
        },
      ]),
    ).toBeUndefined();
  });

  it("does not count a pending check as a failure", () => {
    const pending = advance({ action: "review", ci: "pending", ciFailureCount: 1 });
    expect(pending.reason).toBe("ci_pending");
    expect(pending.ok).toBe(false);
    expect(pending.ciFailureCount).toBe(1);
    expect(pending.effects.map((effect) => effect.kind)).toEqual(["linear.comment"]);
    expect(commentBodies(pending)[0]).toContain("[ci]\nResult: pending\nAttempt: 1/3");
  });

  it("names the failed checks on a red CI log", () => {
    const decision = advance({
      action: "review",
      ci: "red",
      failedChecks: ["ci/lint", "ci/test"],
    });
    expect(commentBodies(decision).join("\n")).toContain("Failed checks: ci/lint, ci/test");
  });

  it("escalates on the third CI failure with when, why, tried, and failed", () => {
    const decision = advance({ action: "review", ci: "red", ciFailureCount: 2 });
    expect(decision.halt).toBe(true);
    expect(decision.reason).toBe("ci_failures");
    expect(decision.ciFailureCount).toBe(3);
    expect(decision.effects[0]).toMatchObject({
      kind: "linear.comment",
      body: expect.stringContaining(
        "[ci]\nResult: red\nFailed checks: combined status\nAttempt: 3/3",
      ),
    });
    expect(decision.effects[1]).toEqual({
      kind: "linear.escalate",
      comment: escalationComment({
        whenIso: WHEN,
        why: "Repeated CI failure (3/3)",
        tried: "In Progress → Review",
        failed: "GitHub checks red (tests, lint, or Actions)",
      }),
    });
    expect(decision.effects[1]).toMatchObject({
      kind: "linear.escalate",
      comment: expect.stringContaining("Next:"),
    });
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
    expect(effect.comment).toContain("[escalate] Human help needed");
    expect(effect.comment).toContain("When: 2026-09-26T15:00:00.000Z");
    expect(effect.comment).toContain("Why: The approach cannot satisfy the schema");
    expect(effect.comment).toContain("Tried: Two rewrites of the parser");
    expect(effect.comment).toContain("Failed: Both still drop the required field");
    expect(effect.comment).toContain("Next: Choose a different approach.");
  });

  it("reverts a human move to Review and does not undraft", () => {
    const human = decideObservedMove({
      toStatus: "Review",
      actor: "human",
      fromStateId: "state-in-progress",
    });
    expect(human.ok).toBe(false);
    expect(human.reason).toBe("human_override");
    expect(human.effects[0]).toEqual({ kind: "linear.revert", stateId: "state-in-progress" });
    expect(human.effects[1]).toMatchObject({
      kind: "linear.comment",
      body: expect.stringContaining("[status]\nStatus: previous\nTrigger: human"),
    });

    const completed = decideObservedMove({
      toStatus: "Completed",
      actor: "human",
      fromStateId: "state-review",
    });
    expect(completed.effects[0]).toEqual({ kind: "linear.revert", stateId: "state-review" });
    expect(completed.effects[1]).toMatchObject({ kind: "linear.comment" });

    const agent = decideObservedMove({ toStatus: "Review", actor: "agent", fromStateId: "x" });
    expect(agent.ok).toBe(true);
    expect(agent.effects).toEqual([]);
    expect(human.effects.some((effect) => effect.kind === "github.ready")).toBe(false);
    expect(human.effects.some((effect) => effect.kind === "github.request_reviewers")).toBe(false);
    expect(human.effects.some((effect) => effect.kind === "github.dispatch_review")).toBe(false);
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
    expect(happy.calls[0]).toBe("draft");
    expect(happy.calls[1]).toBe("status:In Progress");
    expect(happy.calls[2]).toContain("[status]");

    const blocked = ports();
    await applyWorkflowEffects(advance({ action: "review", ci: "red" }), blocked.ports);
    expect(blocked.calls[0]).toBe("status:In Progress");
    expect(blocked.calls.some((call) => call.includes("[status]"))).toBe(true);
    expect(blocked.calls.some((call) => call.includes("[review]"))).toBe(true);
    expect(blocked.calls.some((call) => call.includes("[ci]"))).toBe(true);
    expect(blocked.calls.some((call) => call.startsWith("rereview:"))).toBe(true);
    expect(blocked.calls.some((call) => call === "draft" || call === "ready")).toBe(false);
    expect(blocked.calls).not.toContain("request_reviewers");
    expect(blocked.calls).not.toContain("dispatch_review");

    const entered = ports();
    await applyWorkflowEffects(advance({ action: "review", ci: "green" }), entered.ports);
    expect(entered.calls.slice(0, 4)).toEqual([
      "ready",
      "request_reviewers",
      "dispatch_review",
      "status:Review",
    ]);
  });

  it("moves to Needs Human and comments, or falls back to In Progress", async () => {
    const preferred = ports();
    const decision = advance({ action: "review", ci: "red", ciFailureCount: 2 });
    await applyWorkflowEffects(decision, preferred.ports);
    expect(preferred.calls).toContain("status:Needs Human");
    expect(preferred.calls.some((call) => call.includes("[escalate] Human help needed"))).toBe(
      true,
    );
    expect(preferred.calls.some((call) => call.includes("Next:"))).toBe(true);
    expect(preferred.calls.some((call) => call === "ready")).toBe(false);
    expect(preferred.calls).not.toContain("dispatch_review");

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
      "https://api.github.com/repos/acme/widgets/pulls/9/reviews",
      "https://api.github.com/repos/acme/widgets/issues/9/comments",
    ]);
    for (const call of bodies) {
      expect(call.body).not.toContain("draft");
    }
    expect(JSON.parse(bodies[0]?.body ?? "{}")).toEqual({ reviewers: ["ada"] });
    expect(JSON.parse(bodies[1]?.body ?? "{}")).toMatchObject({
      event: "COMMENT",
      body: expect.stringContaining("Must fix: tests"),
    });
    expect(JSON.parse(bodies[2]?.body ?? "{}").body).toContain("Must fix: tests");
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
        identifier: "ENG-12",
        title: "Ship intake",
        state: { id: "state-review", name: "Review" },
        team: { key: "ENG" },
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
    const comments = graphql.filter((call) => call.query.includes("commentCreate"));
    const revert = graphql.find((call) => call.query.includes("issueUpdate"));
    expect(comments[0]?.variables.body).toBe("queued");
    expect(comments.some((call) => call.variables.body.includes("[status]"))).toBe(true);
    expect(comments.some((call) => call.variables.body.includes("Trigger: human"))).toBe(true);
    expect(revert?.variables).toEqual({ id: issueId, stateId: "state-in-progress" });
    expect(graphql.some((call) => call.query.includes("issueCreate"))).toBe(false);
  });
});
