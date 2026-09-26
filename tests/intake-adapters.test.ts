import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { FlowJob } from "bullmq";
import { afterEach, describe, expect, it } from "vitest";
import { createIntakeServer, signSlackBody } from "../src/index.js";
import { signIntakeWebhookBody } from "../src/orchestrator/intake/webhook-auth.js";
import type { RepoCatalog } from "../src/orchestrator/repos/catalog.js";

const GITHUB_SECRET = "github-webhook-test-secret";
const SLACK_SECRET = "slack-signing-test-secret";

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

  function start() {
    const added: FlowJob[] = [];
    const server = createIntakeServer({
      repoCatalog: catalog,
      workflowRepoId: "workplace",
      githubWebhookSecret: GITHUB_SECRET,
      slackSigningSecret: SLACK_SECRET,
      enqueuer: {
        async add(flow) {
          added.push(flow);
        },
      },
    });
    servers.push(server);
    return { added, server };
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

  it("refuses Linear and an unknown intake repo without enqueueing", async () => {
    const { added, server } = start();
    const base = await listen(server);
    const linear = await fetch(`${base}/webhooks/linear`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "create" }),
    });
    expect(linear.status).toBe(404);
    const linearBody = (await linear.json()) as { error: string; message: string };
    expect(linearBody.error).toBe("linear_deferred");
    expect(linearBody.message).toContain("SPEC ADR");

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
});
