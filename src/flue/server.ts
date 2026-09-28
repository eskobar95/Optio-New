/**
 * Flue sidecar stub (ENG-26).
 * Health + POST /dispatch + POST /start. No real agent loop / cursor-agent I/O.
 *
 * Future Flue agent shape (not executed here):
 *   useModel | useSandbox(local) | useTool(cursor-agent) | useMcpConnection
 * Phases: planner → builder specialists → TDD (Jev-waivable) → CI green
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import {
  FlueDispatchRequestSchema,
  FlueStartRequestSchema,
  type FlueDispatchResponse,
  type FlueStartResponse,
} from "../adapters/flue/contract.js";

const BODY_LIMIT_BYTES = 65_536;

export function resolveFlueListen(env: NodeJS.ProcessEnv = process.env): {
  host: string;
  port: number;
} {
  const host = env.FLUE_HOST?.trim() || "0.0.0.0";
  const parsed = Number(env.FLUE_PORT ?? "3220");
  const port = Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : 3220;
  return { host, port };
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra?: Record<string, string>,
): void {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...extra,
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > BODY_LIMIT_BYTES) {
        failed = true;
        reject(Object.assign(new Error("payload_too_large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!failed) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => {
      if (!failed) reject(error);
    });
  });
}

/** In-memory stub sessions — not durable across process restarts. */
type SessionRecord = {
  sessionId: string;
  durableConversationId: string;
  taskId: string;
  workspaceRef: string;
};

export function createFlueServer(): Server {
  const sessions = new Map<string, SessionRecord>();

  return createServer((req, res) => {
    void handle(req, res, sessions).catch((error: unknown) => {
      const statusCode =
        typeof error === "object" && error && "statusCode" in error && error.statusCode === 413
          ? 413
          : 400;
      const code = statusCode === 413 ? "payload_too_large" : "invalid_request";
      sendJson(res, statusCode, { error: code });
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: Map<string, SessionRecord>,
): Promise<void> {
  const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  const method = req.method ?? "GET";

  if (path === "/health" && (method === "GET" || method === "HEAD")) {
    const body = { ok: true as const, service: "flue" as const };
    if (method === "HEAD") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end();
      return;
    }
    sendJson(res, 200, body);
    return;
  }

  if (path !== "/dispatch" && path !== "/start") {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  if (method !== "POST") {
    sendJson(res, 405, { error: "method_not_allowed" }, { allow: "POST" });
    return;
  }

  const declaredLength = Number(req.headers["content-length"] ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > BODY_LIMIT_BYTES) {
    res.on("finish", () => req.destroy());
    sendJson(res, 413, { error: "payload_too_large" });
    return;
  }

  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    sendJson(res, 400, { error: "invalid_json" });
    return;
  }

  if (path === "/dispatch") {
    const body = FlueDispatchRequestSchema.safeParse(parsed);
    if (!body.success) {
      sendJson(res, 400, { error: "invalid_request", issues: body.error.issues });
      return;
    }
    const resumeId = body.data.durableConversationId?.trim();
    const durableConversationId = resumeId || `flue-conv-${randomUUID()}`;
    const sessionId = randomUUID();
    const status = resumeId ? ("resumed" as const) : ("accepted" as const);
    sessions.set(sessionId, {
      sessionId,
      durableConversationId,
      taskId: body.data.taskId,
      workspaceRef: body.data.workspaceRef,
    });
    const response: FlueDispatchResponse = { sessionId, durableConversationId, status };
    sendJson(res, 200, response);
    return;
  }

  const body = FlueStartRequestSchema.safeParse(parsed);
  if (!body.success) {
    sendJson(res, 400, { error: "invalid_request", issues: body.error.issues });
    return;
  }

  const session = sessions.get(body.data.sessionId);
  if (!session || session.durableConversationId !== body.data.durableConversationId) {
    sendJson(res, 404, { error: "session_not_found" });
    return;
  }
  if (session.taskId !== body.data.taskId) {
    sendJson(res, 400, { error: "task_mismatch" });
    return;
  }

  const branch = `flue/${body.data.taskId}`;
  const response: FlueStartResponse = {
    sessionId: body.data.sessionId,
    branch,
    usageEvents: [
      {
        kind: "token",
        inputTokens: 0,
        outputTokens: 0,
        provider: "flue",
      },
    ],
    status: "succeeded",
    logs: "flue stub: no agent loop (ENG-26)",
  };
  sendJson(res, 200, response);
}
