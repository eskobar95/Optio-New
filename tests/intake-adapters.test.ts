import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { FlowJob } from "bullmq";
import { afterEach, describe, expect, it } from "vitest";
import {
  IntakeTriageTimeoutError,
  createIntakeServer,
  signLinearBody,
  signSlackBody,
  type IntakeTriageDecision,
} from "../src/index.js";
import { signIntakeWebhookBody } from "../src/orchestrator/intake/webhook-auth.js";
import type { RepoCatalog } from "../src/orchestrator/repos/catalog.js";

const GITHUB_SECRET = "github-webhook-test-secret";
const SLACK_SECRET = "slack-signing-test-secret";
const LINEAR_SECRET = "linear-webhook-test-secret";
const LINEAR_ISSUE_ID = "2174add1-f7c8-44e3-bbf3-2d60b5ea8bc9";

const catalog: RepoCatalog = {
  defaultRepoId: "optio-new",
  repos: [
    {
      repoId: "optio-new",
      cloneUrl: "https://github.com/eskobar95/Optio-New.git",
      localPath: "/opt/optio-new",
      defaultBranch: "development",
      worktreeRoot: "/wt/optio-new",
    },
    {
      repoId: "workplace",
      cloneUrl: "https://github.com/KitCollective/workplace.git",
      localPath: "/opt/workplace",
      defaultBranch: "main",
      worktreeRoot: "/wt/workplace",
    },
    {
      repoId: "findjobabroad",
      cloneUrl: "https://github.com/kit/find-job-abroad.git",
      localPath: "/opt/findjobabroad",
      defaultBranch: "main",
      worktreeRoot: "/wt/fja",
    },
  ],
};

function planJob(flow: FlowJob): FlowJob {
  let current = flow;
  while (current.children?.[0]) {
    current = current.children[0] as FlowJob;
  }
  return current;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe("GitHub and Slack intake", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
          }),
      ),
    );
  });

  function start(extra?: {
    linearWebhookSecret?: string;
    linearApiKey?: string;
    linearDefaultRepoId?: string;
    linearComment?: (issueId: string, body?: string) => Promise<void>;
    failEnqueue?: boolean;
    intakeTriage?: Parameters<typeof createIntakeServer>[0]["intakeTriage"];
  }) {
    const added: FlowJob[] = [];
    const server = createIntakeServer({
      repoCatalog: catalog,
      workflowRepoId: "workplace",
      githubWebhookSecret: GITHUB_SECRET,
      slackSigningSecret: SLACK_SECRET,
      linearWebhookSecret: extra?.linearWebhookSecret,
      linearApiKey: extra?.linearApiKey,
      linearDefaultRepoId: extra?.linearDefaultRepoId,
      linearComment: extra?.linearComment,
      intakeTriage: extra?.intakeTriage,
      enqueuer: {
        async add(flow) {
          if (extra?.failEnqueue) throw new Error("Job lin-ENG-12__plan already exists");
          added.push(flow);
        },
      },
    });
    servers.push(server);
    return { added, server };
  }

  function engStatusPayload(overrides?: {
    identifier?: string;
    title?: string;
    description?: string;
  }): Buffer {
    const identifier = overrides?.identifier ?? "ENG-12";
    const payload = JSON.stringify({
      action: "update",
      type: "Issue",
      url: `https://linear.app/findjobabroad/issue/${identifier}/ship`,
      webhookTimestamp: Date.now(),
      data: {
        id: LINEAR_ISSUE_ID,
        identifier,
        title: overrides?.title ?? "Ship intake",
        description: overrides?.description ?? "Status moved",
      },
      updatedFrom: { stateId: "previous-state" },
    });
    return Buffer.from(payload);
  }

  it("enqueues an opened GitHub issue and a labeled optio issue with HMAC", async () => {
    const { added, server } = start();
    const base = await listen(server);
    const opened = JSON.stringify({
      action: "opened",
      issue: { number: 93, title: "Multi-repo", body: "route by repoId" },
      repository: {
        full_name: "eskobar95/Optio-New",
        clone_url: "https://github.com/eskobar95/Optio-New.git",
      },
    });
    const response = await fetch(`${base}/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issues",
        "x-hub-signature-256": signIntakeWebhookBody(GITHUB_SECRET, Buffer.from(opened)),
      },
      body: opened,
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as { taskId: string; repoId: string; source: string };
    expect(body).toMatchObject({
      event: "bot.intake.created",
      taskId: "gh-eskobar95-Optio-New-93",
      repoId: "optio-new",
      source: "github",
    });
    expect(JSON.stringify(body)).not.toContain(GITHUB_SECRET);
    expect(planJob(added[0] as FlowJob).data).toMatchObject({
      taskId: "gh-eskobar95-Optio-New-93",
      repoId: "optio-new",
      title: "Multi-repo",
      stage: "plan",
    });

    const labeled = JSON.stringify({
      action: "labeled",
      label: { name: "optio" },
      issue: { number: 12, title: "Fix login", body: "" },
      repository: {
        full_name: "KitCollective/workplace",
        clone_url: "https://github.com/KitCollective/workplace.git",
      },
    });
    const labeledResponse = await fetch(`${base}/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issues",
        "x-hub-signature-256": signIntakeWebhookBody(GITHUB_SECRET, Buffer.from(labeled)),
      },
      body: labeled,
    });
    expect(labeledResponse.status).toBe(202);
    expect(added).toHaveLength(2);
    expect(planJob(added[1] as FlowJob).data).toMatchObject({ repoId: "workplace" });
  });

  it("ignores other labels, rejects a bad signature, and fails closed without a secret", async () => {
    const { added, server } = start();
    const base = await listen(server);
    const payload = JSON.stringify({
      action: "labeled",
      label: { name: "bug" },
      issue: { number: 1, title: "Bug", body: "" },
      repository: { full_name: "eskobar95/Optio-New", clone_url: "" },
    });
    const ignored = await fetch(`${base}/webhooks/github`, {
      method: "POST",
      headers: {
        "x-github-event": "issues",
        "x-hub-signature-256": signIntakeWebhookBody(GITHUB_SECRET, Buffer.from(payload)),
      },
      body: payload,
    });
    expect(ignored.status).toBe(202);
    expect(await ignored.json()).toEqual({ accepted: false, reason: "ignored" });

    const bad = await fetch(`${base}/webhooks/github`, {
      method: "POST",
      headers: {
        "x-github-event": "issues",
        "x-hub-signature-256": `sha256=${"ab".repeat(32)}`,
      },
      body: payload,
    });
    expect(bad.status).toBe(401);
    const badBody = JSON.stringify(await bad.json());
    expect(badBody).not.toContain(GITHUB_SECRET);
    expect(badBody).not.toContain("ab".repeat(32));

    const closed = createIntakeServer({
      repoCatalog: catalog,
      enqueuer: { async add() {} },
    });
    servers.push(closed);
    const closedBase = await listen(closed);
    const unconfigured = await fetch(`${closedBase}/webhooks/github`, {
      method: "POST",
      headers: {
        "x-hub-signature-256": signIntakeWebhookBody(GITHUB_SECRET, Buffer.from(payload)),
      },
      body: payload,
    });
    expect(unconfigured.status).toBe(503);
    expect(added).toHaveLength(0);
  });

  it("enqueues a Slack slash command and an app mention, and answers url_verification", async () => {
    const { added, server } = start();
    const base = await listen(server);
    const form = new URLSearchParams({
      command: "/optio",
      text: "repo:workplace fix login",
      channel_id: "C1",
      user_id: "U1",
    });
    const raw = Buffer.from(form.toString());
    const timestamp = String(Math.floor(Date.now() / 1000));
    const slash = await fetch(`${base}/webhooks/slack`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signSlackBody(SLACK_SECRET, timestamp, raw),
      },
      body: raw,
    });
    expect(slash.status).toBe(200);
    const slashBody = (await slash.json()) as Record<string, unknown>;
    expect(slashBody).toMatchObject({
      event: "bot.intake.created",
      source: "slack",
      repoId: "workplace",
      response_type: "ephemeral",
      text: "Queued.",
    });
    expect(JSON.stringify(slashBody)).not.toContain(SLACK_SECRET);
    expect(planJob(added[0] as FlowJob).data).toMatchObject({
      repoId: "workplace",
      title: "fix login",
    });

    const mention = JSON.stringify({
      type: "event_callback",
      event: { type: "app_mention", text: "<@UBOT> ship the guard", user: "U9", channel: "C9" },
    });
    const mentionRaw = Buffer.from(mention);
    const mentionResponse = await fetch(`${base}/webhooks/slack`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signSlackBody(SLACK_SECRET, timestamp, mentionRaw),
      },
      body: mentionRaw,
    });
    expect(mentionResponse.status).toBe(200);
    expect(await mentionResponse.json()).toMatchObject({
      source: "slack",
      repoId: "optio-new",
    });
    expect(planJob(added[1] as FlowJob).data).toMatchObject({
      repoId: "optio-new",
      title: "ship the guard",
      description: "ship the guard",
    });

    const challenge = JSON.stringify({ type: "url_verification", challenge: "abc-challenge" });
    const challengeRaw = Buffer.from(challenge);
    const verified = await fetch(`${base}/webhooks/slack`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signSlackBody(SLACK_SECRET, timestamp, challengeRaw),
      },
      body: challengeRaw,
    });
    expect(verified.status).toBe(200);
    expect(await verified.json()).toEqual({ challenge: "abc-challenge" });
    expect(added).toHaveLength(2);
  });

  it("fails a Linear webhook closed when the signing secret is unset", async () => {
    const { added, server } = start();
    const base = await listen(server);
    const linear = await fetch(`${base}/webhooks/linear`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "create" }),
    });
    expect(linear.status).toBe(503);
    const linearBody = (await linear.json()) as { error: string; message: string };
    expect(linearBody.error).toBe("webhook_auth_unconfigured");
    expect(JSON.stringify(linearBody)).not.toContain("linear_deferred");
    expect(added).toHaveLength(0);
  });

  it("rejects an unknown intake repo without enqueueing", async () => {
    const { added, server } = start();
    const base = await listen(server);
    const unknown = await fetch(`${base}/intake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        brief: { title: "Nope" },
        metadata: { taskId: "t-x", repoId: "missing" },
      }),
    });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: "unknown_repo" });

    const workflowDefault = await fetch(`${base}/intake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        brief: { title: "From workflow" },
        metadata: { taskId: "t-wf" },
      }),
    });
    expect(workflowDefault.status).toBe(202);
    expect(await workflowDefault.json()).toMatchObject({ repoId: "workplace" });
    expect(added).toHaveLength(1);
  });

  it("skips enqueue and comments when intake triage rejects, clarifies, or escalates", async () => {
    const cases: { triage: IntakeTriageDecision; expectLabel: string; body: string }[] = [
      {
        triage: {
          action: "reject",
          source: "intake_triage",
          label: "reject",
          confidence: 0.95,
          notes: "spam",
        },
        expectLabel: "reject",
        body: "[intake-triage] reject\nNotes: spam",
      },
      {
        triage: {
          action: "clarify",
          source: "intake_triage",
          label: "clarify",
          confidence: 0.95,
          notes: "need AC",
        },
        expectLabel: "clarify",
        body: "[intake-triage] clarify\nNotes: need AC",
      },
      {
        triage: {
          action: "escalate",
          source: "intake_triage",
          reason: "needs_human",
          confidence: 0.95,
          notes: "policy",
        },
        expectLabel: "needs_human",
        body: "[intake-triage] escalate\nNotes: policy",
      },
    ];
    for (const row of cases) {
      const comments: { issueId: string; body?: string }[] = [];
      const { added, server } = start({
        linearWebhookSecret: LINEAR_SECRET,
        linearDefaultRepoId: "findjobabroad",
        linearComment: async (issueId, body) => {
          comments.push({ issueId, body });
        },
        intakeTriage: async () => row.triage,
      });
      const base = await listen(server);
      const raw = engStatusPayload({
        identifier: "ENG-99",
        title: "Triage skip",
        description: "noise",
      });
      const response = await fetch(`${base}/webhooks/linear`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "linear-signature": signLinearBody(LINEAR_SECRET, raw),
        },
        body: raw,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        accepted: false,
        reason: "intake_triage",
        action: row.triage.action,
        label: row.expectLabel,
      });
      expect(added).toHaveLength(0);
      expect(comments).toEqual([{ issueId: LINEAR_ISSUE_ID, body: row.body }]);
    }
  });

  it("fail-opens IntakeTriageTimeoutError to enqueue, rethrows unexpected triage errors", async () => {
    const timeoutComments: { issueId: string; body?: string }[] = [];
    const { added: timeoutAdded, server: timeoutServer } = start({
      linearWebhookSecret: LINEAR_SECRET,
      linearDefaultRepoId: "findjobabroad",
      linearComment: async (issueId, body) => {
        timeoutComments.push({ issueId, body });
      },
      intakeTriage: async () => {
        throw new IntakeTriageTimeoutError("hard timeout");
      },
    });
    const timeoutBase = await listen(timeoutServer);
    const timeoutRaw = engStatusPayload({ identifier: "ENG-40" });
    const timeoutRes = await fetch(`${timeoutBase}/webhooks/linear`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": signLinearBody(LINEAR_SECRET, timeoutRaw),
      },
      body: timeoutRaw,
    });
    expect(timeoutRes.status).toBe(200);
    expect(await timeoutRes.json()).toMatchObject({
      taskId: "lin-ENG-40",
      repoId: "findjobabroad",
    });
    expect(timeoutAdded).toHaveLength(1);
    expect(timeoutComments).toEqual([{ issueId: LINEAR_ISSUE_ID, body: "queued" }]);

    const { added: boomAdded, server: boomServer } = start({
      linearWebhookSecret: LINEAR_SECRET,
      linearDefaultRepoId: "findjobabroad",
      linearComment: async () => {},
      intakeTriage: async () => {
        throw new Error("unexpected triage bug");
      },
    });
    const boomBase = await listen(boomServer);
    const boomRaw = engStatusPayload({ identifier: "ENG-41" });
    const boomRes = await fetch(`${boomBase}/webhooks/linear`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": signLinearBody(LINEAR_SECRET, boomRaw),
      },
      body: boomRaw,
    });
    expect(boomRes.status).toBe(500);
    expect(await boomRes.json()).toMatchObject({ error: "enqueue_failed" });
    expect(boomAdded).toHaveLength(0);
  });

  it("passthrough-enqueues when Jev API key is missing (no intakeTriage stub)", async () => {
    const prevJev = process.env.OPTIO_NEW_JEV_API_KEY;
    const prevAlt = process.env.JEV_API_KEY;
    delete process.env.OPTIO_NEW_JEV_API_KEY;
    delete process.env.JEV_API_KEY;
    try {
      const comments: { issueId: string; body?: string }[] = [];
      const { added, server } = start({
        linearWebhookSecret: LINEAR_SECRET,
        linearDefaultRepoId: "findjobabroad",
        linearComment: async (issueId, body) => {
          comments.push({ issueId, body });
        },
      });
      const base = await listen(server);
      const raw = engStatusPayload({ identifier: "ENG-42" });
      const response = await fetch(`${base}/webhooks/linear`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "linear-signature": signLinearBody(LINEAR_SECRET, raw),
        },
        body: raw,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        taskId: "lin-ENG-42",
        repoId: "findjobabroad",
      });
      expect(added).toHaveLength(1);
      expect(comments).toEqual([{ issueId: LINEAR_ISSUE_ID, body: "queued" }]);
    } finally {
      if (prevJev === undefined) delete process.env.OPTIO_NEW_JEV_API_KEY;
      else process.env.OPTIO_NEW_JEV_API_KEY = prevJev;
      if (prevAlt === undefined) delete process.env.JEV_API_KEY;
      else process.env.JEV_API_KEY = prevAlt;
    }
  });

  it("enqueues an ENG status change and comments queued", async () => {
    const comments: string[] = [];
    const { added, server } = start({
      linearWebhookSecret: LINEAR_SECRET,
      linearDefaultRepoId: "findjobabroad",
      linearComment: async (issueId) => {
        comments.push(issueId);
      },
    });
    const base = await listen(server);
    const now = Date.now();
    const payload = JSON.stringify({
      action: "update",
      type: "Issue",
      url: "https://linear.app/findjobabroad/issue/ENG-12/ship-intake",
      webhookTimestamp: now,
      data: {
        id: LINEAR_ISSUE_ID,
        identifier: "ENG-12",
        title: "Ship intake",
        description: "Status moved",
      },
      updatedFrom: { stateId: "previous-state" },
    });
    const raw = Buffer.from(payload);
    const response = await fetch(`${base}/webhooks/linear`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": signLinearBody(LINEAR_SECRET, raw),
      },
      body: raw,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { taskId: string; repoId: string; source: string };
    expect(body).toMatchObject({
      event: "bot.intake.created",
      taskId: "lin-ENG-12",
      repoId: "findjobabroad",
      source: "linear",
    });
    expect(JSON.stringify(body)).not.toContain(LINEAR_SECRET);
    expect(comments).toEqual([LINEAR_ISSUE_ID]);
    expect(planJob(added[0] as FlowJob).data).toMatchObject({
      taskId: "lin-ENG-12",
      repoId: "findjobabroad",
      title: "Ship intake",
      description: "Status moved\n\nhttps://linear.app/findjobabroad/issue/ENG-12/ship-intake",
      stage: "plan",
    });

    const titleEdit = JSON.stringify({
      action: "update",
      type: "Issue",
      webhookTimestamp: now,
      data: {
        id: LINEAR_ISSUE_ID,
        identifier: "ENG-12",
        title: "Renamed",
        team: { key: "ENG" },
      },
      updatedFrom: { title: "Ship intake" },
    });
    const titleRaw = Buffer.from(titleEdit);
    const renamed = await fetch(`${base}/webhooks/linear`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": signLinearBody(LINEAR_SECRET, titleRaw),
      },
      body: titleRaw,
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toEqual({ accepted: false, reason: "ignored" });

    const noise = JSON.stringify({
      action: "create",
      type: "Issue",
      webhookTimestamp: now,
      data: { id: LINEAR_ISSUE_ID, identifier: "FIN-13", title: "Created" },
    });
    const noiseRaw = Buffer.from(noise);
    const ignored = await fetch(`${base}/webhooks/linear`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": signLinearBody(LINEAR_SECRET, noiseRaw),
      },
      body: noiseRaw,
    });
    expect(ignored.status).toBe(200);
    expect(await ignored.json()).toEqual({ accepted: false, reason: "ignored" });

    const otherTeam = JSON.stringify({
      action: "update",
      type: "Issue",
      webhookTimestamp: now,
      data: {
        id: LINEAR_ISSUE_ID,
        identifier: "KIT-3",
        title: "Other team",
        team: { key: "KIT" },
      },
      updatedFrom: { stateId: "previous-state" },
    });
    const otherRaw = Buffer.from(otherTeam);
    const other = await fetch(`${base}/webhooks/linear`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": signLinearBody(LINEAR_SECRET, otherRaw),
      },
      body: otherRaw,
    });
    expect(other.status).toBe(200);
    expect(await other.json()).toEqual({ accepted: false, reason: "ignored" });
    expect(added).toHaveLength(1);
    expect(comments).toEqual([LINEAR_ISSUE_ID]);
  });

  it("rejects a bad Linear signature and a stale timestamp", async () => {
    const comments: string[] = [];
    const { added, server } = start({
      linearWebhookSecret: LINEAR_SECRET,
      linearDefaultRepoId: "findjobabroad",
      linearComment: async (issueId) => {
        comments.push(issueId);
      },
    });
    const base = await listen(server);
    const payload = JSON.stringify({
      action: "update",
      type: "Issue",
      webhookTimestamp: Date.now(),
      data: {
        id: LINEAR_ISSUE_ID,
        identifier: "FIN-12",
        title: "Ship intake",
        team: { key: "FIN" },
      },
      updatedFrom: { stateId: "previous-state" },
    });
    const bad = await fetch(`${base}/webhooks/linear`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": signLinearBody("wrong-secret", Buffer.from(payload)),
      },
      body: payload,
    });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toMatchObject({ error: "invalid_signature" });

    const staleBody = JSON.stringify({
      action: "update",
      type: "Issue",
      webhookTimestamp: Date.now() - 120_000,
      data: {
        id: LINEAR_ISSUE_ID,
        identifier: "FIN-12",
        title: "Ship intake",
        team: { key: "FIN" },
      },
      updatedFrom: { stateId: "previous-state" },
    });
    const staleRaw = Buffer.from(staleBody);
    const stale = await fetch(`${base}/webhooks/linear`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": signLinearBody(LINEAR_SECRET, staleRaw),
      },
      body: staleRaw,
    });
    expect(stale.status).toBe(401);
    expect(added).toHaveLength(0);
    expect(comments).toEqual([]);
  });

  it("uses the ENG config repo when the env override is blank, and still fails closed for a bad repo or missing API key", async () => {
    const { added, server } = start({
      linearWebhookSecret: LINEAR_SECRET,
      linearApiKey: "lin_api_testkey12345678",
      linearComment: async () => {},
    });
    const base = await listen(server);
    const payload = JSON.stringify({
      action: "update",
      type: "Issue",
      webhookTimestamp: Date.now(),
      data: {
        id: LINEAR_ISSUE_ID,
        identifier: "ENG-12",
        title: "Ship intake",
        team: { key: "ENG" },
      },
      updatedFrom: { stateId: "previous-state" },
    });
    const raw = Buffer.from(payload);
    const fromConfig = await fetch(`${base}/webhooks/linear`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": signLinearBody(LINEAR_SECRET, raw),
      },
      body: raw,
    });
    expect(fromConfig.status).toBe(200);
    expect(await fromConfig.json()).toMatchObject({
      taskId: "lin-ENG-12",
      repoId: "findjobabroad",
    });

    const { server: keyed } = start({
      linearWebhookSecret: LINEAR_SECRET,
      linearDefaultRepoId: "missing-repo",
      linearApiKey: "lin_api_testkey12345678",
    });
    const keyedBase = await listen(keyed);
    const unknown = await fetch(`${keyedBase}/webhooks/linear`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": signLinearBody(LINEAR_SECRET, raw),
      },
      body: raw,
    });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: "unknown_repo" });

    const { server: noKey } = start({
      linearWebhookSecret: LINEAR_SECRET,
      linearDefaultRepoId: "findjobabroad",
    });
    const noKeyBase = await listen(noKey);
    const unconfigured = await fetch(`${noKeyBase}/webhooks/linear`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": signLinearBody(LINEAR_SECRET, raw),
      },
      body: raw,
    });
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toMatchObject({ error: "linear_api_unconfigured" });
    expect(added).toHaveLength(1);
  });

  it("comments queued again when the Linear pipeline job already exists", async () => {
    const comments: string[] = [];
    const { added, server } = start({
      linearWebhookSecret: LINEAR_SECRET,
      linearDefaultRepoId: "findjobabroad",
      failEnqueue: true,
      linearComment: async (issueId) => {
        comments.push(issueId);
      },
    });
    const base = await listen(server);
    const payload = JSON.stringify({
      action: "update",
      type: "Issue",
      webhookTimestamp: Date.now(),
      data: {
        id: LINEAR_ISSUE_ID,
        identifier: "ENG-12",
        title: "Ship intake",
        team: { key: "ENG" },
      },
      updatedFrom: { stateId: "previous-state" },
    });
    const raw = Buffer.from(payload);
    const response = await fetch(`${base}/webhooks/linear`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": signLinearBody(LINEAR_SECRET, raw),
      },
      body: raw,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ taskId: "lin-ENG-12", repoId: "findjobabroad" });
    expect(comments).toEqual([LINEAR_ISSUE_ID]);
    expect(added).toHaveLength(0);
  });
});
