/**
 * GitHub Issues webhook → bot.intake.created.
 * HMAC is X-Hub-Signature-256 over the raw body (OPTIO_NEW_GITHUB_WEBHOOK_SECRET).
 * Triggers: issues opened, or labeled `optio`. Other events are ignored.
 */
import { UnknownRepoError, matchRepoId, type RepoCatalog } from "../../repos/catalog.js";
import { BOT_INTAKE_CREATED, type BotIntakeCreated } from "../event.js";
import { signIntakeWebhookBody } from "../webhook-auth.js";
import { asRecord, headerValue, signaturesMatch, type IntakeAdapterResult } from "./shared.js";

export const GITHUB_WEBHOOK_PATH = "/webhooks/github";
export const GITHUB_SIGNATURE_HEADER = "x-hub-signature-256";
export const GITHUB_EVENT_HEADER = "x-github-event";
export const OPTIO_LABEL = "optio";

function safeToken(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function stringField(record: Record<string, unknown> | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

export function handleGithubWebhook(input: {
  raw: Buffer;
  headers: Record<string, string | string[] | undefined>;
  secret: string | undefined;
  catalog: RepoCatalog;
}): IntakeAdapterResult {
  const trimmed = input.secret?.trim() ?? "";
  if (!trimmed) {
    return {
      action: "respond",
      status: 503,
      body: {
        error: "webhook_auth_unconfigured",
        message: "GitHub webhook secret is not configured",
      },
    };
  }

  const expected = signIntakeWebhookBody(trimmed, input.raw);
  const presented = headerValue(input.headers[GITHUB_SIGNATURE_HEADER]);
  if (!signaturesMatch(expected, presented)) {
    return {
      action: "respond",
      status: 401,
      body: {
        error: "invalid_signature",
        message: "GitHub webhook signature is invalid",
      },
    };
  }

  const eventName = headerValue(input.headers[GITHUB_EVENT_HEADER]);
  if (eventName !== "issues") {
    return {
      action: "respond",
      status: 202,
      body: { accepted: false, reason: "ignored" },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.raw.toString("utf8")) as unknown;
  } catch {
    return {
      action: "respond",
      status: 400,
      body: { error: "invalid_json", message: "Request body must be JSON" },
    };
  }

  const body = asRecord(parsed);
  const action = stringField(body, "action");
  const labelName = stringField(asRecord(body?.label), "name");
  const opened = action === "opened";
  const labeledOptio = action === "labeled" && labelName === OPTIO_LABEL;
  if (!opened && !labeledOptio) {
    return {
      action: "respond",
      status: 202,
      body: { accepted: false, reason: "ignored" },
    };
  }

  const issue = asRecord(body?.issue);
  const repository = asRecord(body?.repository);
  const title = stringField(issue, "title").trim();
  const number = issue?.number;
  const fullName = stringField(repository, "full_name");
  if (
    !title ||
    typeof number !== "number" ||
    !Number.isInteger(number) ||
    number < 1 ||
    !fullName
  ) {
    return {
      action: "respond",
      status: 400,
      body: { error: "invalid_intake", message: "GitHub issue payload is invalid" },
    };
  }

  const taskId = safeToken(`gh-${fullName}-${number}`);
  if (!taskId || taskId.includes(":")) {
    return {
      action: "respond",
      status: 400,
      body: { error: "invalid_intake", message: "GitHub issue cannot name a task" },
    };
  }

  let repoId: string;
  try {
    repoId = matchRepoId(input.catalog, {
      fullName,
      cloneUrl: stringField(repository, "clone_url"),
    });
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

  const description = stringField(issue, "body");
  const intake: BotIntakeCreated = {
    event: BOT_INTAKE_CREATED,
    taskId,
    title,
    description,
    repoId,
    source: "github",
  };
  return { action: "enqueue", status: 202, intake };
}
