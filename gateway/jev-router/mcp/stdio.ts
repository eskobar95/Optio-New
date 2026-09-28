/**
 * Stdio transport for Jev MCP (ENG-27).
 * Protocol on stdout; diagnostics on stderr only.
 */

import type { Readable, Writable } from "node:stream";
import {
  ContentLengthParser,
  encodeContentLengthMessage,
  type JsonRpcRequest,
} from "./protocol.js";
import { createJevMcpServer, type JevMcpServer, type JevMcpServerOptions } from "./server.js";

export interface JevMcpStdioOptions extends JevMcpServerOptions {
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
  server?: JevMcpServer;
}

export interface JevMcpStdioHandle {
  server: JevMcpServer;
  /** Resolves when stdin ends. */
  closed: Promise<void>;
  close(): void;
}

export function startJevMcpStdio(options: JevMcpStdioOptions = {}): JevMcpStdioHandle {
  const server = options.server ?? createJevMcpServer(options);
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const parser = new ContentLengthParser();
  let closedResolve: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    closedResolve = resolve;
  });

  const onData = (chunk: Buffer | string) => {
    const messages = parser.push(chunk);
    for (const message of messages) {
      void dispatch(message);
    }
  };

  const dispatch = async (message: JsonRpcRequest) => {
    try {
      const response = await server.handle(message);
      if (response) {
        stdout.write(encodeContentLengthMessage(response));
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      stderr.write(`jev-mcp error: ${text}\n`);
    }
  };

  const onEnd = () => {
    cleanup();
    closedResolve?.();
  };

  const cleanup = () => {
    stdin.off("data", onData);
    stdin.off("end", onEnd);
    stdin.off("close", onEnd);
  };

  stdin.on("data", onData);
  stdin.on("end", onEnd);
  stdin.on("close", onEnd);
  if (typeof stdin.resume === "function") stdin.resume();

  return {
    server,
    closed,
    close() {
      cleanup();
      closedResolve?.();
    },
  };
}
