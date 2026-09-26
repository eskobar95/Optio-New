/**
 * HTTP API for the kit-harness sidecar.
 * Bind address is chosen by the process; Compose publishes 127.0.0.1 only.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import { readToolAudit } from "./audit.js";
import { checkCompletion } from "./completion-check.js";
import { runStubbedFlow } from "./flow.js";
import { detectLoop } from "./loop-detect.js";
import { routeModel } from "./model-routing.js";
import { splitOrProceed } from "./split-or-proceed.js";
import { decideTool } from "./tool-gate.js";
import { invokeGuardedTool } from "./tool-invoke.js";
import type { DecisionAdvisor } from "./types.js";
import { runIsolationProbe } from "./worktree.js";

const BODY_LIMIT_BYTES = 65_536;

const RouteModelBody = z
  .object({
    step_id: z.string().min(1).optional(),
    workflow_id: z.string().min(1).optional(),
    task_id: z.string().min(1).optional(),
    coding_backend: z.enum(["cursor", "codex", "auto"]).optional(),
    cursor_quota_remaining: z.number().optional(),
    codex_quota_remaining: z.number().optional(),
    budget_usd_remaining: z.number().optional(),
    cost_estimate_usd: z.number().optional(),
    force_deny: z.boolean().optional(),
  })
  .strict();

const ToolGateBody = z
  .object({
    tool: z.string().min(1),
    context: z
      .object({
        step_id: z.string().optional(),
        agent_id: z.string().optional(),
        command: z.string().optional(),
        path: z.string().optional(),
        run_id: z.string().min(1).optional(),
        max_tool_calls: z.number().int().positive().optional(),
        args: z.record(z.unknown()).optional(),
        allowed_tools: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const CompletionBody = z
  .object({
    tests_green: z.boolean().optional(),
    typecheck_green: z.boolean().optional(),
    lint_green: z.boolean().optional(),
    diff_present: z.boolean().optional(),
    open_blockers: z.array(z.string()).optional(),
    ci_status: z.enum(["success", "failure", "pending", "missing"]).optional(),
    attempt: z.number().int().positive().optional(),
    max_attempts: z.number().int().positive().optional(),
  })
  .strict();

const LoopBody = z
  .object({
    events: z
      .array(
        z
          .object({
            fingerprint: z.string(),
            tool: z.string().optional(),
            outcome: z.enum(["fail", "ok", "deny"]),
          })
          .strict(),
      )
      .max(200),
    threshold: z.number().int().min(2).max(50).optional(),
    tool_thrash_threshold: z.number().int().min(2).max(50).optional(),
  })
  .strict();

const InvokeBody = z
  .object({
    tool: z.string().min(1),
    timeout_ms: z.number().int().min(10).max(2_000),
    mode: z.enum(["hang", "ok"]),
    context: z
      .object({
        path: z.string().optional(),
        command: z.string().optional(),
        agent_id: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const FlowBody = z
  .object({
    task_id: z.string().min(1),
    title: z.string().min(1),
  })
  .strict();

const SplitBody = z
  .object({
    title: z.string().optional(),
    description: z.string().max(20_000).optional(),
    estimated_files: z.number().int().nonnegative().optional(),
    estimated_steps: z.number().int().nonnegative().optional(),
    signals: z.array(z.string()).max(20).optional(),
    max_files_before_split: z.number().int().positive().optional(),
    max_steps_before_split: z.number().int().positive().optional(),
  })
  .strict();

export interface KitHarnessServerOptions {
  advisor?: DecisionAdvisor | null;
  /** Defaults to process.env. Used for the health flag only — v0 does not call Jev. */
  env?: NodeJS.ProcessEnv;
}

export function resolveListen(env: NodeJS.ProcessEnv = process.env): {
  host: string;
  port: number;
} {
  const host = env.KIT_HARNESS_HOST?.trim() || "0.0.0.0";
  const parsed = Number(env.KIT_HARNESS_PORT ?? "3200");
  const port = Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : 3200;
  return { host, port };
}

function jevConfigured(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.JEV_BASE_URL?.trim());
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

function issuesFrom(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

export function createKitHarnessServer(options: KitHarnessServerOptions = {}): Server {
  const env = options.env ?? process.env;
  const advisor = options.advisor ?? null;

  return createServer((req, res) => {
    void handle(req, res, env, advisor).catch((error: unknown) => {
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
  env: NodeJS.ProcessEnv,
  advisor: DecisionAdvisor | null,
): Promise<void> {
  const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  const method = req.method ?? "GET";

  if (path === "/health" && (method === "GET" || method === "HEAD")) {
    const body = {
      ok: true,
      service: "kit-harness",
      engine: "rules",
      jev_configured: jevConfigured(env),
    };
    if (method === "HEAD") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end();
      return;
    }
    sendJson(res, 200, body);
    return;
  }

  if (path === "/v1/audit" && method === "GET") {
    sendJson(res, 200, { entries: readToolAudit() });
    return;
  }

  const postRoutes = new Set([
    "/v1/route-model",
    "/v1/tool-gate",
    "/v1/completion-check",
    "/v1/loop-detect",
    "/v1/split-or-proceed",
    "/v1/tool-invoke",
    "/v1/flow",
    "/v1/worktree-isolation",
  ]);

  if (!postRoutes.has(path)) {
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
    sendJson(res, 400, {
      error: "invalid_request",
      issues: [{ path: "", message: "invalid json" }],
    });
    return;
  }

  if (path === "/v1/route-model") {
    const body = RouteModelBody.safeParse(parsed);
    if (!body.success) {
      sendJson(res, 400, { error: "invalid_request", issues: issuesFrom(body.error) });
      return;
    }
    sendJson(res, 200, await routeModel(body.data, advisor));
    return;
  }
  if (path === "/v1/tool-gate") {
    const body = ToolGateBody.safeParse(parsed);
    if (!body.success) {
      sendJson(res, 400, { error: "invalid_request", issues: issuesFrom(body.error) });
      return;
    }
    sendJson(res, 200, await decideTool(body.data.tool, body.data.context ?? {}, advisor));
    return;
  }
  if (path === "/v1/completion-check") {
    const body = CompletionBody.safeParse(parsed);
    if (!body.success) {
      sendJson(res, 400, { error: "invalid_request", issues: issuesFrom(body.error) });
      return;
    }
    sendJson(res, 200, await checkCompletion(body.data, advisor));
    return;
  }
  if (path === "/v1/loop-detect") {
    const body = LoopBody.safeParse(parsed);
    if (!body.success) {
      sendJson(res, 400, { error: "invalid_request", issues: issuesFrom(body.error) });
      return;
    }
    sendJson(res, 200, detectLoop(body.data));
    return;
  }
  if (path === "/v1/tool-invoke") {
    const body = InvokeBody.safeParse(parsed);
    if (!body.success) {
      sendJson(res, 400, { error: "invalid_request", issues: issuesFrom(body.error) });
      return;
    }
    const result = await invokeGuardedTool({
      tool: body.data.tool,
      context: body.data.context,
      timeout_ms: body.data.timeout_ms,
      run: (signal) => {
        if (body.data.mode === "ok") return Promise.resolve({ ok: true });
        return new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve({ aborted: true }));
        });
      },
    });
    sendJson(res, 200, result);
    return;
  }
  if (path === "/v1/flow") {
    const body = FlowBody.safeParse(parsed);
    if (!body.success) {
      sendJson(res, 400, { error: "invalid_request", issues: issuesFrom(body.error) });
      return;
    }
    sendJson(res, 200, await runStubbedFlow(body.data));
    return;
  }
  if (path === "/v1/worktree-isolation") {
    const body = z.object({}).strict().safeParse(parsed);
    if (!body.success) {
      sendJson(res, 400, { error: "invalid_request", issues: issuesFrom(body.error) });
      return;
    }
    sendJson(res, 200, runIsolationProbe());
    return;
  }

  const body = SplitBody.safeParse(parsed);
  if (!body.success) {
    sendJson(res, 400, { error: "invalid_request", issues: issuesFrom(body.error) });
    return;
  }
  sendJson(res, 200, splitOrProceed(body.data));
}
