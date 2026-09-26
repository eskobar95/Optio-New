/**
 * Optional Slack intake: slash command `/optio` or an app_mention.
 * Signing secret is OPTIO_NEW_SLACK_SIGNING_SECRET (v0 HMAC). Blank secret fails closed.
 * `repo:<id>` in the text selects a catalog repo; otherwise the default is used.
 */
import { createHmac } from "node:crypto";
import {
  REPO_ID_PATTERN,
  UnknownRepoError,
  selectRepoId,
  type RepoCatalog,
} from "../../repos/catalog.js";
import { BOT_INTAKE_CREATED, type BotIntakeCreated } from "../event.js";
import { asRecord, headerValue, signaturesMatch, type IntakeAdapterResult } from "./shared.js";

export const SLACK_WEBHOOK_PATH = "/webhooks/slack";
export const SLACK_SIGNATURE_HEADER = "x-slack-signature";
export const SLACK_TIMESTAMP_HEADER = "x-slack-request-timestamp";

const SKEW_MS = 5 * 60 * 1000;

export function signSlackBody(secret: string, timestamp: string, body: Buffer): string {
  const base = `v0:${timestamp}:${body.toString("utf8")}`;
  const hex = createHmac("sha256", secret).update(base).digest("hex");
  return `v0=${hex}`;
}

function safeToken(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function stripMentions(text: string): string {
  return text
    .replace(/<@[A-Z0-9]+>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseRepoSelector(text: string): { repoId?: string; title: string } {
  const match = text.match(/(?:^|\s)repo:([A-Za-z0-9][A-Za-z0-9._-]*)\b/);
  const repoId = match?.[1] && REPO_ID_PATTERN.test(match[1]) ? match[1] : undefined;
  const title = text
    .replace(/(?:^|\s)repo:[A-Za-z0-9][A-Za-z0-9._-]*\b/, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { repoId, title };
}

function taskIdFor(channel: string, user: string, text: string): string {
  const digest = createHmac("sha256", "optio-slack-task")
    .update(`${channel}\n${user}\n${text}`)
    .digest("hex")
    .slice(0, 12);
  const id = safeToken(`slack-${channel}-${digest}`);
  return id || `slack-${digest}`;
}

function enqueueText(
  catalog: RepoCatalog,
  text: string,
  channel: string,
  user: string,
): IntakeAdapterResult {
  const cleaned = stripMentions(text);
  const selected = parseRepoSelector(cleaned);
  const title = selected.title;
  if (!title) {
    return {
      action: "respond",
      status: 400,
      body: { error: "invalid_intake", message: "Slack text is empty" },
    };
  }
  let repoId: string;
  try {
    repoId = selectRepoId({ catalog, requested: selected.repoId });
  } catch (error) {
    if (error instanceof UnknownRepoError) {
      return {
        action: "respond",
        status: 400,
        body: { error: "unknown_repo", message: error.message },
      };
    }
    throw error;
  }
  const intake: BotIntakeCreated = {
    event: BOT_INTAKE_CREATED,
    taskId: taskIdFor(channel, user, cleaned),
    title,
    description: cleaned,
    repoId,
    source: "slack",
  };
  return { action: "enqueue", status: 200, intake };
}

export function handleSlackWebhook(input: {
  raw: Buffer;
  headers: Record<string, string | string[] | undefined>;
  secret: string | undefined;
  catalog: RepoCatalog;
  nowMs?: number;
}): IntakeAdapterResult {
  const trimmed = input.secret?.trim() ?? "";
  if (!trimmed) {
    return {
      action: "respond",
      status: 503,
      body: {
        error: "webhook_auth_unconfigured",
        message: "Slack signing secret is not configured",
      },
    };
  }

  const timestamp = headerValue(input.headers[SLACK_TIMESTAMP_HEADER]);
  const expected = signSlackBody(trimmed, timestamp, input.raw);
  const presented = headerValue(input.headers[SLACK_SIGNATURE_HEADER]);
  if (!timestamp || !signaturesMatch(expected, presented)) {
    return {
      action: "respond",
      status: 401,
      body: { error: "invalid_signature", message: "Slack signature is invalid" },
    };
  }

  const ts = Number(timestamp);
  const now = input.nowMs ?? Date.now();
  if (!Number.isFinite(ts) || Math.abs(now - ts * 1000) > SKEW_MS) {
    return {
      action: "respond",
      status: 401,
      body: { error: "invalid_signature", message: "Slack signature is invalid" },
    };
  }

  const contentType = headerValue(input.headers["content-type"]);
  const text = input.raw.toString("utf8");
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(text);
    if (params.get("command") !== "/optio") {
      return {
        action: "respond",
        status: 200,
        body: { accepted: false, reason: "ignored" },
      };
    }
    return enqueueText(
      input.catalog,
      params.get("text") ?? "",
      params.get("channel_id") ?? "channel",
      params.get("user_id") ?? "user",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return {
      action: "respond",
      status: 400,
      body: { error: "invalid_json", message: "Request body must be JSON" },
    };
  }
  const body = asRecord(parsed);
  if (stringField(body, "type") === "url_verification") {
    const challenge = stringField(body, "challenge");
    if (!challenge) {
      return {
        action: "respond",
        status: 400,
        body: { error: "invalid_intake", message: "Slack challenge is missing" },
      };
    }
    return { action: "respond", status: 200, body: { challenge } };
  }

  const event = asRecord(body?.event);
  if (stringField(event, "type") !== "app_mention") {
    return {
      action: "respond",
      status: 200,
      body: { accepted: false, reason: "ignored" },
    };
  }
  return enqueueText(
    input.catalog,
    stringField(event, "text"),
    stringField(event, "channel") || "channel",
    stringField(event, "user") || "user",
  );
}

function stringField(record: Record<string, unknown> | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}
