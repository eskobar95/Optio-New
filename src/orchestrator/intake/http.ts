/**
 * HTTP intake for New Bot. Validates a task brief and metadata, then enqueues
 * the first BullMQ stage (`optio.plan`) via enqueueIntakePipeline.
 * Workers own later stages. Linear status-change intake is the SPEC §8 exception.
 * Agent Sessions stay out of this module.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ZodError, z } from "zod";
import { enqueueIntakePipeline, type FlowEnqueuer } from "../jobs/enqueue-pipeline.js";
import type { SessionArtifactTrail } from "../artifacts/trail.js";
import { HELLO_WORLD_RESPONSE, type PlanStageView } from "../jobs/hello-world.js";
import { HitlDecisionError, type HitlAction, type HitlPoint } from "../jobs/hitl.js";
import type { TaskRunView } from "../observability/run-log.js";
import { PipelineIdentitySchema, STAGE_QUEUES } from "../jobs/stages.js";
import {
  REPO_ID_PATTERN,
  UnknownRepoError,
  loadRepoCatalog,
  selectRepoId,
  type RepoCatalog,
} from "../repos/catalog.js";
import { GITHUB_WEBHOOK_PATH, handleGithubWebhook } from "./adapters/github.js";
import { LINEAR_WEBHOOK_PATH, handleLinearWebhook } from "./adapters/linear.js";
import { SLACK_WEBHOOK_PATH, handleSlackWebhook } from "./adapters/slack.js";
import type { IntakeAdapterResult } from "./adapters/shared.js";
import { commentQueuedOnIssue, LINEAR_QUEUED_COMMENT } from "../linear/comment.js";
import { commentOnIssue } from "../linear/status.js";
import { enforceObservedLinearStatus } from "../linear/observe.js";
import { createJevClient } from "../../../gateway/jev-router/jev-client.js";
import {
  evaluateIntakeTriageWithGate,
  IntakeTriageTimeoutError,
  type IntakeTriageDecision,
  type IntakeTriageLogFn,
} from "../jev/intake-triage-gate.js";
import { redactSecrets } from "./redact.js";
import {
  authorizeIntakeWebhook,
  INTAKE_WEBHOOK_PATH,
  INTAKE_WEBHOOK_SIGNATURE_HEADER,
} from "./webhook-auth.js";

/** Linear Issue status-change intake. Same path the v1 refusal used. */
export const TRACKER_WEBHOOK_PATH = LINEAR_WEBHOOK_PATH;

const MAX_BODY_BYTES = 65_536;

const PipelineIdSchema = PipelineIdentitySchema.shape.taskId;

const HelloPlanQuerySchema = z.object({
  taskId: PipelineIdSchema,
  sessionId: PipelineIdSchema,
});

const ApprovalDecisionSchema = z.object({
  taskId: PipelineIdSchema,
  sessionId: PipelineIdSchema.optional(),
  point: z.enum(["plan", "merge"]),
  action: z.enum(["approve", "reject", "replan"]),
});

const ArtifactTrailQuerySchema = HelloPlanQuerySchema;

export const IntakeHttpSchema = z.object({
  brief: z.object({
    title: z.string().min(1),
    description: z.string().optional(),
  }),
  metadata: z.object({
    taskId: PipelineIdSchema,
    sessionId: PipelineIdSchema.optional(),
    repo: z.string().min(1).optional(),
    baseBranch: z.string().min(1).optional(),
    /** Catalog selector. Omitted uses the workflow repo_id, then the catalog default. */
    repoId: z.string().regex(REPO_ID_PATTERN, "repoId must be a safe token").optional(),
  }),
});

export type IntakeHttpRequest = z.infer<typeof IntakeHttpSchema>;

export interface IntakeHealthReport {
  ok: boolean;
  redis: "up" | "down";
}

export interface IntakeServerOptions {
  enqueuer: FlowEnqueuer;
  /** When set, GET /health pings Redis. Omitted means the route stays 404. */
  checkRedis?: () => Promise<boolean>;
  /**
   * When set, GET /hello/plan reads the plan step cursor.
   * Omitted means that route stays 404. GET /hello does not need it.
   */
  readPlanStage?: (taskId: string, sessionId: string) => Promise<PlanStageView>;
  /**
   * When set, GET /tasks/:taskId/actions returns stage timing, usage, and agent actions.
   * Omitted means that route stays 404.
   */
  readTaskActions?: (taskId: string) => Promise<TaskRunView>;
  /**
   * When set, GET /tasks/:taskId/artifacts dumps the session artifact trail.
   * Omitted means that route stays 404.
   */
  readArtifactTrail?: (taskId: string, sessionId: string) => Promise<SessionArtifactTrail>;
  /**
   * HMAC secret for POST /webhooks/intake. Blank or omitted fails that route closed (503).
   * POST /intake does not read this value.
   */
  webhookSecret?: string;
  /** Repo catalog. Omitted uses the built-in single default checkout (not process.env). */
  repoCatalog?: RepoCatalog;
  /** `repo_id` from workflows/default-task.yaml, when the file names one. */
  workflowRepoId?: string;
  /** HMAC secret for POST /webhooks/github. Blank fails that route closed (503). */
  githubWebhookSecret?: string;
  /** HMAC secret for POST /webhooks/slack. Blank fails that route closed (503). */
  slackSigningSecret?: string;
  /** HMAC secret for POST /webhooks/linear. Blank fails that route closed (503). */
  linearWebhookSecret?: string;
  /** GraphQL key used to comment `queued` after a Linear issue is accepted. */
  linearApiKey?: string;
  /** Catalog repo for accepted Linear issues. Blank fails an accept closed (503). */
  linearDefaultRepoId?: string;
  /**
   * Replaces Linear GraphQL comments. Tests inject this.
   * Second arg is the body (`queued` for Phase 1, or `[intake-triage] …` when triage skips).
   */
  linearComment?: (issueId: string, body?: string) => Promise<void>;
  /** GraphQL fetch for the Linear comment. Defaults to global fetch. */
  linearFetch?: typeof fetch;
  /**
   * ENG-25 gate #5 — Jev intake triage on Linear enqueue path.
   * Omitted → createJevClient from env (soft timeout → enqueue / Phase 1 `queued`).
   * Inject a stub in tests.
   */
  intakeTriage?: (input: {
    taskId: string;
    title: string;
    description: string;
    source: string;
    linearToStatus?: string;
  }) => Promise<IntakeTriageDecision>;
  /** Optional log sink for intake triage decisions (defaults to console.log JSON). */
  onIntakeTriageLog?: IntakeTriageLogFn;
  /** When set, GET/POST /approvals reads and decides human gates. Omitted means 404. */
  approvals?: {
    list(taskId: string, sessionId: string): Promise<unknown>;
    decide(input: {
      taskId: string;
      sessionId: string;
      point: HitlPoint;
      action: HitlAction;
    }): Promise<unknown>;
  };
  /** When set, GET /budget returns caps and usage. Omitted means 404. */
  budgetStatus?: (taskId: string, sessionId: string) => Promise<unknown>;
}

export interface IntakeAccepted {
  taskId: string;
  sessionId: string;
  jobId: string;
  queue: string;
  repoId: string;
}

class IntakeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(typeof body.message === "string" ? body.message : "intake error");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      throw new IntakeHttpError(413, {
        error: "payload_too_large",
        message: "Request body exceeds 64 KiB",
      });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function parseJsonBody(raw: Buffer): unknown {
  const text = raw.toString("utf8");
  if (text.trim() === "") {
    throw new IntakeHttpError(400, {
      error: "invalid_json",
      message: "Request body must be JSON",
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new IntakeHttpError(400, {
      error: "invalid_json",
      message: "Request body must be JSON",
    });
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return parseJsonBody(await readRawBody(req));
}

function taskActionsId(pathname: string): string | undefined {
  const prefix = "/tasks/";
  const suffix = "/actions";
  if (
    !pathname.startsWith(prefix) ||
    !pathname.endsWith(suffix) ||
    pathname.length <= prefix.length + suffix.length
  ) {
    return undefined;
  }
  let taskId: string;
  try {
    taskId = decodeURIComponent(pathname.slice(prefix.length, -suffix.length));
  } catch {
    return undefined;
  }
  if (!taskId || taskId.includes("/")) return undefined;
  return taskId;
}

async function acceptIntake(
  json: unknown,
  res: ServerResponse,
  options: IntakeServerOptions,
): Promise<void> {
  const parsed = IntakeHttpSchema.parse(json);
  const catalog = options.repoCatalog ?? loadRepoCatalog({});
  let repoId: string;
  try {
    repoId = selectRepoId({
      catalog,
      requested: parsed.metadata.repoId,
      workflowRepoId: options.workflowRepoId,
    });
  } catch (error) {
    if (error instanceof UnknownRepoError) {
      throw new IntakeHttpError(400, {
        error: "unknown_repo",
        message: error.message,
      });
    }
    throw error;
  }
  const enqueued = await enqueueIntakePipeline(
    {
      taskId: parsed.metadata.taskId,
      title: parsed.brief.title,
      description: parsed.brief.description ?? "",
      repoId,
      source: "http",
      event: "bot.intake.created",
    },
    options.enqueuer,
    parsed.metadata.sessionId,
  );
  const accepted: IntakeAccepted = {
    taskId: enqueued.taskId,
    sessionId: enqueued.sessionId,
    jobId: `${enqueued.sessionId}__plan`,
    queue: STAGE_QUEUES.plan,
    repoId,
  };
  sendJson(res, 202, accepted);
}

function isDuplicatePipelineJob(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already exists/i.test(message);
}

const INTAKE_ISSUE_BODY_MAX_CHARS = 4000;

async function deliverLinearQueuedComment(
  issueId: string,
  options: IntakeServerOptions,
): Promise<void> {
  if (options.linearComment) {
    await options.linearComment(issueId, LINEAR_QUEUED_COMMENT);
    return;
  }
  const apiKey = options.linearApiKey?.trim() ?? "";
  if (!apiKey) {
    throw new IntakeHttpError(503, {
      error: "linear_api_unconfigured",
      message: "Linear API key is not configured",
    });
  }
  await commentQueuedOnIssue({ apiKey, issueId, fetchImpl: options.linearFetch });
}

function formatIntakeTriageSkipComment(triage: IntakeTriageDecision): string {
  const notes = triage.notes?.trim();
  const lines = [`[intake-triage] ${triage.action}`];
  if (notes) lines.push(`Notes: ${notes}`);
  return lines.join("\n");
}

async function deliverLinearIssueComment(
  issueId: string,
  body: string,
  options: IntakeServerOptions,
): Promise<void> {
  if (options.linearComment) {
    await options.linearComment(issueId, body);
    return;
  }
  const apiKey = options.linearApiKey?.trim() ?? "";
  if (!apiKey) {
    throw new IntakeHttpError(503, {
      error: "linear_api_unconfigured",
      message: "Linear API key is not configured",
    });
  }
  await commentOnIssue({ apiKey, issueId, body, fetchImpl: options.linearFetch });
}

function issueIdentifierFromTaskId(taskId: string): string | undefined {
  const trimmed = taskId.trim();
  if (!trimmed.startsWith("lin-")) return undefined;
  const identifier = trimmed.slice("lin-".length).trim();
  return identifier || undefined;
}

async function runIntakeTriage(
  result: Extract<IntakeAdapterResult, { action: "enqueue" }>,
  options: IntakeServerOptions,
): Promise<IntakeTriageDecision> {
  const cappedBody = result.intake.description.slice(0, INTAKE_ISSUE_BODY_MAX_CHARS);
  const issueIdentifier = issueIdentifierFromTaskId(result.intake.taskId);
  if (options.intakeTriage) {
    return options.intakeTriage({
      taskId: result.intake.taskId,
      title: result.intake.title,
      description: cappedBody,
      source: result.intake.source,
      ...(result.linearToStatus ? { linearToStatus: result.linearToStatus } : {}),
    });
  }

  const onLog: IntakeTriageLogFn =
    options.onIntakeTriageLog ??
    ((entry) => {
      console.log(JSON.stringify({ msg: "intake triage", ...entry }));
    });

  // No API key → soft passthrough (Phase 1 enqueue + `queued`). Avoids cold HTTP in tests/dev.
  const apiKey = process.env.OPTIO_NEW_JEV_API_KEY?.trim() || process.env.JEV_API_KEY?.trim() || "";
  if (!apiKey) {
    const decision: IntakeTriageDecision = {
      action: "enqueue",
      source: "passthrough",
      reason: "undecided",
      message: "jev_unconfigured",
    };
    onLog({
      task_id: result.intake.taskId,
      outcome: "passthrough",
      reason: "undecided",
      message: "jev_unconfigured",
      ...(issueIdentifier ? { issue_identifier: issueIdentifier } : {}),
    });
    return decision;
  }

  const client = createJevClient({ env: process.env });
  return evaluateIntakeTriageWithGate({
    client,
    state: {
      task_id: result.intake.taskId,
      issue_title: result.intake.title,
      issue_body: cappedBody,
      source: result.intake.source,
      ...(issueIdentifier ? { issue_identifier: issueIdentifier } : {}),
      ...(result.linearToStatus ? { to_status: result.linearToStatus } : {}),
    },
    onLog,
  });
}

async function enqueueAdapter(
  result: Extract<IntakeAdapterResult, { action: "enqueue" }>,
  res: ServerResponse,
  options: IntakeServerOptions,
): Promise<void> {
  // Gate #5 only on Linear status-change intake. Soft timeout → enqueue; other errors rethrow.
  if (result.intake.source === "linear" && result.linearIssueId) {
    let triage: IntakeTriageDecision;
    try {
      triage = await runIntakeTriage(result, options);
    } catch (error) {
      if (!(error instanceof IntakeTriageTimeoutError)) throw error;
      // Soft seam: hard timeout must not block Phase 1 — passthrough to enqueue.
      console.log(
        JSON.stringify({
          msg: "intake triage",
          task_id: result.intake.taskId,
          outcome: "passthrough",
          reason: "timeout",
          message: error.message,
        }),
      );
      triage = {
        action: "enqueue",
        source: "passthrough",
        reason: "timeout",
        message: error.message,
      };
    }
    if (triage.action !== "enqueue") {
      await deliverLinearIssueComment(
        result.linearIssueId,
        formatIntakeTriageSkipComment(triage),
        options,
      );
      sendJson(res, 200, {
        accepted: false,
        reason: "intake_triage",
        action: triage.action,
        source: triage.source,
        ...(triage.action === "escalate"
          ? { label: "needs_human", confidence: triage.confidence }
          : { label: triage.label, confidence: triage.confidence }),
        ...(triage.notes !== undefined ? { notes: triage.notes } : {}),
        taskId: result.intake.taskId,
        repoId: result.intake.repoId,
      });
      return;
    }
  }

  let taskId = result.intake.taskId;
  let sessionId = result.intake.taskId;
  try {
    const enqueued = await enqueueIntakePipeline(result.intake, options.enqueuer);
    taskId = enqueued.taskId;
    sessionId = enqueued.sessionId;
  } catch (error) {
    if (!result.linearIssueId || !isDuplicatePipelineJob(error)) throw error;
  }
  if (result.linearIssueId) {
    await deliverLinearQueuedComment(result.linearIssueId, options);
    const toStatus = result.linearToStatus?.trim() ?? "";
    const apiKey = options.linearApiKey?.trim() ?? "";
    if (toStatus && apiKey) {
      await enforceObservedLinearStatus({
        issueId: result.linearIssueId,
        toStatus,
        fromStateId: result.linearFromStateId,
        apiKey,
        fetchImpl: options.linearFetch,
      });
    }
  }
  const body: Record<string, unknown> = {
    event: result.intake.event,
    taskId,
    sessionId,
    jobId: `${sessionId}__plan`,
    queue: STAGE_QUEUES.plan,
    repoId: result.intake.repoId,
    source: result.intake.source,
  };
  if (result.intake.source === "slack") {
    body.response_type = "ephemeral";
    body.text = "Queued.";
  }
  sendJson(res, result.status, body);
}

function identityFromQuery(url: URL): { taskId: string; sessionId: string } {
  const sessionRaw = url.searchParams.get("sessionId");
  return HelloPlanQuerySchema.parse({
    taskId: url.searchParams.get("taskId") ?? "",
    sessionId:
      sessionRaw && sessionRaw.length > 0 ? sessionRaw : (url.searchParams.get("taskId") ?? ""),
  });
}

async function handleApprovals(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: IntakeServerOptions,
): Promise<void> {
  if (!options.approvals) {
    sendJson(res, 404, { error: "not_found", message: "Approvals are unavailable" });
    return;
  }
  if (req.method === "GET") {
    const query = identityFromQuery(url);
    const approvals = await options.approvals.list(query.taskId, query.sessionId);
    sendJson(res, 200, {
      ok: true,
      taskId: query.taskId,
      sessionId: query.sessionId,
      approvals,
    });
    return;
  }
  if (req.method !== "POST") {
    res.setHeader("allow", "GET, POST");
    sendJson(res, 405, { error: "method_not_allowed", message: "Use GET or POST /approvals" });
    return;
  }
  const parsed = ApprovalDecisionSchema.parse(await readJsonBody(req));
  const decided = await options.approvals.decide({
    taskId: parsed.taskId,
    sessionId: parsed.sessionId ?? parsed.taskId,
    point: parsed.point,
    action: parsed.action,
  });
  sendJson(res, 200, { ok: true, approval: decided });
}

async function handleBudget(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: IntakeServerOptions,
): Promise<void> {
  if (req.method !== "GET") {
    res.setHeader("allow", "GET");
    sendJson(res, 405, { error: "method_not_allowed", message: "Use GET /budget" });
    return;
  }
  if (!options.budgetStatus) {
    sendJson(res, 404, { error: "not_found", message: "Budget status is unavailable" });
    return;
  }
  const query = identityFromQuery(url);
  sendJson(res, 200, await options.budgetStatus(query.taskId, query.sessionId));
}

function invalidIntake(error: ZodError): IntakeHttpError {
  return new IntakeHttpError(400, {
    error: "invalid_intake",
    message: "Intake payload is invalid",
    issues: error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  });
}

export async function handleIntakeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: IntakeServerOptions,
): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health" && options.checkRedis) {
      if (req.method !== "GET") {
        res.setHeader("allow", "GET");
        sendJson(res, 405, {
          error: "method_not_allowed",
          message: "Use GET /health",
        });
        return;
      }
      const redisUp = await options.checkRedis();
      const body: IntakeHealthReport = { ok: redisUp, redis: redisUp ? "up" : "down" };
      sendJson(res, redisUp ? 200 : 503, body);
      return;
    }
    if (url.pathname === "/hello") {
      if (req.method !== "GET") {
        res.setHeader("allow", "GET");
        sendJson(res, 405, {
          error: "method_not_allowed",
          message: "Use GET /hello",
        });
        return;
      }
      sendJson(res, 200, HELLO_WORLD_RESPONSE);
      return;
    }
    if (url.pathname === "/hello/plan") {
      if (req.method !== "GET") {
        res.setHeader("allow", "GET");
        sendJson(res, 405, {
          error: "method_not_allowed",
          message: "Use GET /hello/plan",
        });
        return;
      }
      if (!options.readPlanStage) {
        sendJson(res, 404, {
          error: "not_found",
          message: "Plan progress is unavailable",
        });
        return;
      }
      const sessionRaw = url.searchParams.get("sessionId");
      const query = HelloPlanQuerySchema.parse({
        taskId: url.searchParams.get("taskId") ?? "",
        sessionId:
          sessionRaw && sessionRaw.length > 0 ? sessionRaw : (url.searchParams.get("taskId") ?? ""),
      });
      const view = await options.readPlanStage(query.taskId, query.sessionId);
      sendJson(res, 200, view);
      return;
    }
    const taskId = taskActionsId(url.pathname);
    if (taskId !== undefined) {
      if (req.method !== "GET") {
        res.setHeader("allow", "GET");
        sendJson(res, 405, {
          error: "method_not_allowed",
          message: "Use GET /tasks/:taskId/actions",
        });
        return;
      }
      if (!options.readTaskActions) {
        sendJson(res, 404, {
          error: "not_found",
          message: "Task actions are unavailable",
        });
        return;
      }
      const parsedId = PipelineIdSchema.safeParse(taskId);
      if (!parsedId.success) {
        throw parsedId.error;
      }
      sendJson(res, 200, await options.readTaskActions(parsedId.data));
      return;
    }
    if (url.pathname === "/approvals") {
      await handleApprovals(req, res, url, options);
      return;
    }
    if (url.pathname === "/budget") {
      await handleBudget(req, res, url, options);
      return;
    }
    const artifactMatch = /^\/tasks\/([^/]+)\/artifacts$/.exec(url.pathname);
    if (artifactMatch) {
      if (req.method !== "GET") {
        res.setHeader("allow", "GET");
        sendJson(res, 405, {
          error: "method_not_allowed",
          message: "Use GET /tasks/:taskId/artifacts",
        });
        return;
      }
      if (!options.readArtifactTrail) {
        sendJson(res, 404, {
          error: "not_found",
          message: "Artifact trail is unavailable",
        });
        return;
      }
      const artifactTaskId = decodeURIComponent(artifactMatch[1] ?? "");
      const sessionRaw = url.searchParams.get("sessionId");
      const query = ArtifactTrailQuerySchema.parse({
        taskId: artifactTaskId,
        sessionId: sessionRaw && sessionRaw.length > 0 ? sessionRaw : artifactTaskId,
      });
      const trail = await options.readArtifactTrail(query.taskId, query.sessionId);
      sendJson(res, 200, trail);
      return;
    }
    if (url.pathname === INTAKE_WEBHOOK_PATH) {
      if (req.method !== "POST") {
        res.setHeader("allow", "POST");
        sendJson(res, 405, {
          error: "method_not_allowed",
          message: "Use POST /webhooks/intake",
        });
        return;
      }
      const raw = await readRawBody(req);
      const auth = authorizeIntakeWebhook(
        options.webhookSecret,
        raw,
        req.headers[INTAKE_WEBHOOK_SIGNATURE_HEADER],
      );
      if (!auth.ok) {
        sendJson(res, auth.status, { error: auth.error, message: auth.message });
        return;
      }
      await acceptIntake(parseJsonBody(raw), res, options);
      return;
    }
    if (
      url.pathname === GITHUB_WEBHOOK_PATH ||
      url.pathname === SLACK_WEBHOOK_PATH ||
      url.pathname === TRACKER_WEBHOOK_PATH
    ) {
      if (req.method !== "POST") {
        res.setHeader("allow", "POST");
        sendJson(res, 405, {
          error: "method_not_allowed",
          message: `Use POST ${url.pathname}`,
        });
        return;
      }
      const raw = await readRawBody(req);
      const catalog = options.repoCatalog ?? loadRepoCatalog({});
      const adapter =
        url.pathname === GITHUB_WEBHOOK_PATH
          ? handleGithubWebhook({
              raw,
              headers: req.headers,
              secret: options.githubWebhookSecret,
              catalog,
            })
          : url.pathname === SLACK_WEBHOOK_PATH
            ? handleSlackWebhook({
                raw,
                headers: req.headers,
                secret: options.slackSigningSecret,
                catalog,
              })
            : handleLinearWebhook({
                raw,
                headers: req.headers,
                secret: options.linearWebhookSecret,
                catalog,
                defaultRepoId: options.linearDefaultRepoId,
                apiKeyConfigured:
                  Boolean(options.linearApiKey?.trim()) || Boolean(options.linearComment),
              });
      if (adapter.action === "respond") {
        sendJson(res, adapter.status, adapter.body);
        return;
      }
      await enqueueAdapter(adapter, res, options);
      return;
    }
    if (url.pathname !== "/intake") {
      sendJson(res, 404, {
        error: "not_found",
        message:
          "Known routes: GET /health, GET /hello, GET /hello/plan, GET /tasks/:taskId/actions, GET /tasks/:taskId/artifacts, GET /approvals, POST /approvals, GET /budget, POST /intake, POST /webhooks/intake, POST /webhooks/github, POST /webhooks/slack, POST /webhooks/linear",
      });
      return;
    }
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      sendJson(res, 405, {
        error: "method_not_allowed",
        message: "Use POST /intake",
      });
      return;
    }

    await acceptIntake(await readJsonBody(req), res, options);
  } catch (error) {
    if (error instanceof IntakeHttpError) {
      sendJson(res, error.status, error.body);
      return;
    }
    if (error instanceof HitlDecisionError) {
      sendJson(res, error.statusCode, { error: error.code, message: error.message });
      return;
    }
    if (error instanceof ZodError) {
      const invalid = invalidIntake(error);
      sendJson(res, invalid.status, invalid.body);
      return;
    }
    const message = redactSecrets(error instanceof Error ? error.message : "Enqueue failed");
    sendJson(res, 500, { error: "enqueue_failed", message });
  }
}

export function createIntakeServer(options: IntakeServerOptions): Server {
  return createServer((req, res) => {
    void handleIntakeRequest(req, res, options);
  });
}
