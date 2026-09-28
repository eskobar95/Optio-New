/**
 * Jev MCP server — soft mid-run tools for Cursor CLI (ENG-27).
 */

import { ZodError } from "zod";
import type { JevClient } from "../jev-client.js";
import { createJevClient } from "../jev-client.js";
import { runJevDecide, runJevEvaluate } from "./midrun.js";
import { errorResult, okResult, type JsonRpcRequest, type JsonRpcResponse } from "./protocol.js";
import { JEV_DECIDE_INPUT_JSON_SCHEMA, JEV_EVALUATE_INPUT_JSON_SCHEMA } from "./schemas.js";
import type { JevMcpTelemetry } from "./telemetry.js";
import { noopJevMcpTelemetry } from "./telemetry.js";

export const JEV_MCP_SERVER_INFO = {
  name: "optio-jev-mcp",
  version: "0.1.0",
} as const;

export const JEV_MCP_TOOLS = [
  {
    name: "jev_evaluate",
    description:
      "Soft mid-run evaluate (continue vs escalate, next file, tests green enough). Optional — agent may ignore.",
    inputSchema: JEV_EVALUATE_INPUT_JSON_SCHEMA,
  },
  {
    name: "jev_decide",
    description:
      "Soft mid-run decide: continue, escalate, pick_file, run_tests, or defer. Timeout → passthrough.",
    inputSchema: JEV_DECIDE_INPUT_JSON_SCHEMA,
  },
] as const;

export interface JevMcpServerOptions {
  client?: JevClient;
  telemetry?: JevMcpTelemetry;
  env?: NodeJS.ProcessEnv;
}

export interface JevMcpServer {
  handle(message: JsonRpcRequest): Promise<JsonRpcResponse | null>;
  listTools(): typeof JEV_MCP_TOOLS;
}

function toolTextResult(payload: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

export function createJevMcpServer(options: JevMcpServerOptions = {}): JevMcpServer {
  const client =
    options.client ??
    createJevClient({
      env: options.env ?? process.env,
    });
  const telemetry = options.telemetry ?? noopJevMcpTelemetry;

  return {
    listTools() {
      return JEV_MCP_TOOLS;
    },

    async handle(message: JsonRpcRequest): Promise<JsonRpcResponse | null> {
      const { method, id } = message;
      const isNotification = id === undefined || id === null;

      if (method === "notifications/initialized" || method === "initialized") {
        return null;
      }

      if (method === "initialize") {
        return okResult(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: JEV_MCP_SERVER_INFO,
        });
      }

      if (method === "ping") {
        return okResult(id, {});
      }

      if (method === "tools/list") {
        return okResult(id, { tools: [...JEV_MCP_TOOLS] });
      }

      if (method === "tools/call") {
        const params = (message.params ?? {}) as {
          name?: string;
          arguments?: unknown;
        };
        const name = params.name;
        const args = params.arguments ?? {};

        try {
          if (name === "jev_evaluate") {
            const outcome = await runJevEvaluate({ client, input: args, telemetry });
            return okResult(id, toolTextResult(outcome));
          }
          if (name === "jev_decide") {
            const outcome = await runJevDecide({ client, input: args, telemetry });
            return okResult(id, toolTextResult(outcome));
          }
          return okResult(id, {
            ...toolTextResult({
              kind: "passthrough",
              reason: "undecided",
              message: `unknown tool: ${name}`,
            }),
            isError: true,
          });
        } catch (error) {
          if (error instanceof ZodError) {
            return okResult(id, {
              ...toolTextResult({
                kind: "passthrough",
                reason: "undecided",
                message: error.errors.map((e) => e.message).join("; "),
              }),
              isError: true,
            });
          }
          const messageText = error instanceof Error ? error.message : String(error);
          return errorResult(id, -32000, messageText);
        }
      }

      if (isNotification) return null;
      return errorResult(id, -32601, `Method not found: ${method}`);
    },
  };
}
