/**
 * HTTP surface for the local eve-runner. GET /health, POST /v1/steps.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { EveRequestError } from "./contract.js";
import { runEveStep, type EveRunOptions } from "./run-step.js";

export interface EveServerOptions extends EveRunOptions {
  port?: number;
  host?: string;
}

const BODY_LIMIT = 1_000_000;

export function createEveHttpServer(options: EveRunOptions = {}): Server {
  return createServer((req, res) => {
    void handle(req, res, options);
  });
}

export async function startEveHttpServer(options: EveServerOptions = {}): Promise<{
  server: Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}> {
  const server = createEveHttpServer(options);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new EveRequestError(500, "listen_failed", "HTTP server has no TCP port");
  }
  return {
    server,
    port: address.port,
    url: `http://${host}:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  options: EveRunOptions,
): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "eve-runner" });
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/steps") {
      const body = await readBody(req);
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        throw new EveRequestError(400, "invalid_json", "Request body is not JSON");
      }
      const result = await runEveStep(payload, options);
      console.error(
        JSON.stringify({
          service: "eve-runner",
          event: "agent.run",
          taskId: result.taskId,
          stepId: result.stepId,
          status: result.artifacts.adapter.status,
          graphAdvanced: false,
        }),
      );
      sendJson(res, 200, result);
      return;
    }
    sendJson(res, 404, {
      ok: false,
      graphAdvanced: false,
      error: { class: "not_found", message: "Not found" },
    });
  } catch (error) {
    if (error instanceof EveRequestError) {
      sendJson(res, error.statusCode, {
        ok: false,
        graphAdvanced: false,
        error: { class: error.errorClass, message: error.message },
      });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 500, {
      ok: false,
      graphAdvanced: false,
      error: { class: "internal", message },
    });
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > BODY_LIMIT) {
    return Promise.reject(new EveRequestError(413, "body_too_large", "JSON body exceeds 1MB"));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        fail(new EveRequestError(413, "body_too_large", "JSON body exceeds 1MB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", fail);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}
