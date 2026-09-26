/**
 * HTTP intake for New Bot. Validates a task brief and metadata, then enqueues
 * the first BullMQ stage (`optio.plan`) via enqueueIntakePipeline.
 * Workers own later stages. This module does not call Linear.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ZodError, z } from "zod";
import { enqueueIntakePipeline, type FlowEnqueuer } from "../jobs/enqueue-pipeline.js";
import { PipelineIdentitySchema, STAGE_QUEUES } from "../jobs/stages.js";

const MAX_BODY_BYTES = 65_536;

const PipelineIdSchema = PipelineIdentitySchema.shape.taskId;

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
}

export interface IntakeAccepted {
  taskId: string;
  sessionId: string;
  jobId: string;
  queue: string;
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

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
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
  const text = Buffer.concat(chunks).toString("utf8");
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
    if (url.pathname !== "/intake") {
      sendJson(res, 404, {
        error: "not_found",
        message: "POST /intake is the intake route",
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

    const json = await readJsonBody(req);
    const parsed = IntakeHttpSchema.parse(json);
    const enqueued = await enqueueIntakePipeline(
      {
        taskId: parsed.metadata.taskId,
        title: parsed.brief.title,
        description: parsed.brief.description ?? "",
      },
      options.enqueuer,
      parsed.metadata.sessionId,
    );
    const accepted: IntakeAccepted = {
      taskId: enqueued.taskId,
      sessionId: enqueued.sessionId,
      jobId: `${enqueued.sessionId}__plan`,
      queue: STAGE_QUEUES.plan,
    };
    sendJson(res, 202, accepted);
  } catch (error) {
    if (error instanceof IntakeHttpError) {
      sendJson(res, error.status, error.body);
      return;
    }
    if (error instanceof ZodError) {
      const invalid = invalidIntake(error);
      sendJson(res, invalid.status, invalid.body);
      return;
    }
    const message = error instanceof Error ? error.message : "Enqueue failed";
    sendJson(res, 500, { error: "enqueue_failed", message });
  }
}

export function createIntakeServer(options: IntakeServerOptions): Server {
  return createServer((req, res) => {
    void handleIntakeRequest(req, res, options);
  });
}
