/**
 * Minimal MCP Content-Length JSON-RPC framing (ENG-27).
 * No @modelcontextprotocol/sdk — keep the stub tiny.
 */

/** Hard cap on a single framed body (bytes). Prevents unbounded buffer growth. */
export const MAX_MCP_CONTENT_LENGTH = 1_048_576;

export interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export function encodeContentLengthMessage(payload: unknown): string {
  const body = JSON.stringify(payload);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

/**
 * Incremental Content-Length frame parser for stdin chunks.
 */
export class ContentLengthParser {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer | string): JsonRpcRequest[] {
    this.buffer = Buffer.concat([
      this.buffer,
      typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk,
    ]);
    const messages: JsonRpcRequest[] = [];

    while (true) {
      if (this.buffer.length > MAX_MCP_CONTENT_LENGTH * 2) {
        this.buffer = Buffer.alloc(0);
        break;
      }

      const headerEnd = indexOfHeaderEnd(this.buffer);
      if (headerEnd < 0) break;

      const headerText = this.buffer.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(headerText);
      if (!match) {
        // Drop a leading line and retry — tolerate noise on stderr mix-ups.
        const nl = this.buffer.indexOf(0x0a);
        if (nl < 0) break;
        this.buffer = this.buffer.subarray(nl + 1);
        continue;
      }

      const length = Number(match[1]);
      if (!Number.isFinite(length) || length < 0 || length > MAX_MCP_CONTENT_LENGTH) {
        this.buffer = Buffer.alloc(0);
        break;
      }

      const bodyStart = headerEnd + 4; // \r\n\r\n
      if (this.buffer.length < bodyStart + length) break;

      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);

      try {
        const parsed = JSON.parse(body) as JsonRpcRequest;
        if (parsed && typeof parsed.method === "string") {
          messages.push(parsed);
        }
      } catch {
        /* ignore malformed frame */
      }
    }

    return messages;
  }
}

function indexOfHeaderEnd(buf: Buffer): number {
  const needle = Buffer.from("\r\n\r\n", "utf8");
  for (let i = 0; i <= buf.length - needle.length; i += 1) {
    if (
      buf[i] === needle[0] &&
      buf[i + 1] === needle[1] &&
      buf[i + 2] === needle[2] &&
      buf[i + 3] === needle[3]
    ) {
      return i;
    }
  }
  return -1;
}

export function okResult(id: string | number | null | undefined, result: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: id === undefined ? null : id,
    result,
  };
}

export function errorResult(
  id: string | number | null | undefined,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: id === undefined ? null : id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}
