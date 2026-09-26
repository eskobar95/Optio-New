/**
 * HTTP intake for New Bot. Validates a task brief and metadata, then enqueues
 * the first BullMQ stage (`optio.plan`) via enqueueIntakePipeline.
 * Workers own later stages. This module does not call Linear.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ZodError, z } from "zod";
import { enqueueIntakePipeline, type FlowEnqueuer } from "../jobs/enqueue-pipeline.js";
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
import { SLACK_WEBHOOK_PATH, handleSlackWebhook } from "./adapters/slack.js";
import type { IntakeAdapterResult } from "./adapters/shared.js";
import { redactSecrets } from "./redact.js";
import {
  authorizeIntakeWebhook,
  INTAKE_WEBHOOK_PATH,
  INTAKE_WEBHOOK_SIGNATURE_HEADER,
} from "./webhook-auth.js";

/** Linear stays out of v1 (SPEC ADR). This path exists so the refusal is explicit. */
export const TRACKER_WEBHOOK_PATH = "/webhooks/linear";

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

async function enqueueAdapter(
  result: Extract<IntakeAdapterResult, { action: "enqueue" }>,
  res: ServerResponse,
  options: IntakeServerOptions,
): Promise<void> {
  const enqueued = await enqueueIntakePipeline(result.intake, options.enqueuer);
  const body: Record<string, unknown> = {
    event: result.intake.event,
    taskId: enqueued.taskId,
    sessionId: enqueued.sessionId,
    jobId: `${enqueued.sessionId}__plan`,
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
    if (url.pathname === GITHUB_WEBHOOK_PATH || url.pathname === SLACK_WEBHOOK_PATH) {
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
          : handleSlackWebhook({
              raw,
              headers: req.headers,
              secret: options.slackSigningSecret,
              catalog,
            });
      if (adapter.action === "respond") {
        sendJson(res, adapter.status, adapter.body);
        return;
      }
      await enqueueAdapter(adapter, res, options);
      return;
    }
    if (url.pathname === TRACKER_WEBHOOK_PATH) {
      sendJson(res, 404, {
        error: "linear_deferred",
        message:
          "Linear intake is out of scope for Optio-New v1 (SPEC ADR). Use New Bot, GitHub Issues, or Slack.",
      });
      return;
    }
    if (url.pathname !== "/intake") {
      sendJson(res, 404, {
        error: "not_found",
        message:
          "Known routes: GET /health, GET /hello, GET /hello/plan, GET /tasks/:taskId/actions, GET /approvals, POST /approvals, GET /budget, POST /intake, POST /webhooks/intake, POST /webhooks/github, POST /webhooks/slack",
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
