/**
 * Linear Issue status-change webhook → bot.intake.created.
 * HMAC is Linear-Signature: hex HMAC-SHA256 of the raw body
 * (OPTIO_NEW_LINEAR_WEBHOOK_SECRET). Team scope is the enabled keys in
 * config/linear-projects.yaml. repoId is OPTIO_NEW_LINEAR_DEFAULT_REPO_ID
 * when set, otherwise that team's defaultRepoId.
 * Other events return 200 so Linear does not retry them.
 */
import { createHmac } from "node:crypto";
import { UnknownRepoError, selectRepoId, type RepoCatalog } from "../../repos/catalog.js";
import {
  LinearProjectsConfigError,
  enabledLinearTeam,
  linearIntakeRepoId,
  loadLinearProjectsConfig,
} from "../../linear/policy.js";
import { BOT_INTAKE_CREATED, type BotIntakeCreated } from "../event.js";
import { asRecord, headerValue, signaturesMatch, type IntakeAdapterResult } from "./shared.js";

export const LINEAR_WEBHOOK_PATH = "/webhooks/linear";
export const LINEAR_SIGNATURE_HEADER = "linear-signature";

const SKEW_MS = 60_000;

export function signLinearBody(secret: string, body: Buffer): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

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

function ignored(): IntakeAdapterResult {
  return { action: "respond", status: 200, body: { accepted: false, reason: "ignored" } };
}

function teamKey(data: Record<string, unknown>): string {
  const nested = stringField(asRecord(data.team), "key").trim();
  if (nested) return nested;
  const identifier = stringField(data, "identifier").trim();
  const match = /^([A-Z][A-Z0-9]+)-\d+$/.exec(identifier);
  return match?.[1] ?? "";
}

function isStatusChange(body: Record<string, unknown>): boolean {
  const updated = asRecord(body.updatedFrom);
  if (!updated) return false;
  return Object.prototype.hasOwnProperty.call(updated, "stateId");
}

function timestampMs(body: Record<string, unknown>): number | undefined {
  const value = body.webhookTimestamp;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

export function handleLinearWebhook(input: {
  raw: Buffer;
  headers: Record<string, string | string[] | undefined>;
  secret: string | undefined;
  catalog: RepoCatalog;
  defaultRepoId: string | undefined;
  apiKeyConfigured: boolean;
  nowMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): IntakeAdapterResult {
  const trimmed = input.secret?.trim() ?? "";
  if (!trimmed) {
    return {
      action: "respond",
      status: 503,
      body: {
        error: "webhook_auth_unconfigured",
        message: "Linear webhook secret is not configured",
      },
    };
  }

  const expected = signLinearBody(trimmed, input.raw);
  const presented = headerValue(input.headers[LINEAR_SIGNATURE_HEADER]).toLowerCase();
  if (!signaturesMatch(expected, presented)) {
    return {
      action: "respond",
      status: 401,
      body: {
        error: "invalid_signature",
        message: "Linear webhook signature is invalid",
      },
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
  if (!body) {
    return {
      action: "respond",
      status: 400,
      body: { error: "invalid_json", message: "Request body must be JSON" },
    };
  }

  const sentAt = timestampMs(body);
  const now = input.nowMs ?? Date.now();
  if (sentAt === undefined || Math.abs(now - sentAt) > SKEW_MS) {
    return {
      action: "respond",
      status: 401,
      body: {
        error: "invalid_signature",
        message: "Linear webhook signature is invalid",
      },
    };
  }

  if (stringField(body, "type") !== "Issue" || stringField(body, "action") !== "update") {
    return ignored();
  }
  if (!isStatusChange(body)) return ignored();

  const data = asRecord(body.data);
  if (!data) return ignored();

  let projects;
  try {
    projects = loadLinearProjectsConfig({ env: input.env, cwd: input.cwd });
  } catch (error) {
    if (error instanceof LinearProjectsConfigError) {
      return {
        action: "respond",
        status: 503,
        body: {
          error: "linear_projects_unconfigured",
          message: "Linear projects config is missing or invalid",
        },
      };
    }
    throw error;
  }

  const team = enabledLinearTeam(projects, teamKey(data));
  if (!team) return ignored();

  const title = stringField(data, "title").trim();
  const issueId = stringField(data, "id").trim();
  const identifier = stringField(data, "identifier").trim();
  if (!title || !issueId || issueId.includes(":")) {
    return {
      action: "respond",
      status: 400,
      body: { error: "invalid_intake", message: "Linear issue payload is invalid" },
    };
  }

  const taskId = safeToken(identifier ? `lin-${identifier}` : `lin-${issueId}`);
  if (!taskId || taskId.includes(":")) {
    return {
      action: "respond",
      status: 400,
      body: { error: "invalid_intake", message: "Linear issue cannot name a task" },
    };
  }

  const requested = linearIntakeRepoId(team, input.defaultRepoId);
  if (!requested) {
    return {
      action: "respond",
      status: 503,
      body: {
        error: "linear_repo_unconfigured",
        message: "OPTIO_NEW_LINEAR_DEFAULT_REPO_ID is not configured",
      },
    };
  }

  let repoId: string;
  try {
    repoId = selectRepoId({ catalog: input.catalog, requested });
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

  if (!input.apiKeyConfigured) {
    return {
      action: "respond",
      status: 503,
      body: {
        error: "linear_api_unconfigured",
        message: "Linear API key is not configured",
      },
    };
  }

  const url = stringField(body, "url") || stringField(data, "url");
  const description = [stringField(data, "description").trim(), url].filter(Boolean).join("\n\n");
  const intake: BotIntakeCreated = {
    event: BOT_INTAKE_CREATED,
    taskId,
    title,
    description,
    repoId,
    source: "linear",
    linearIssueId: issueId,
  };
  const toStatus = stringField(asRecord(data.state), "name").trim();
  const fromStateId = stringField(asRecord(body.updatedFrom), "stateId").trim();
  return {
    action: "enqueue",
    status: 200,
    intake,
    linearIssueId: issueId,
    ...(toStatus ? { linearToStatus: toStatus } : {}),
    ...(fromStateId ? { linearFromStateId: fromStateId } : {}),
  };
}
