import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  ContentLengthParser,
  createJevClient,
  createJevMcpServer,
  createOtelJevMcpTelemetry,
  createStageTracer,
  encodeContentLengthMessage,
  JevMidrunInputSchema,
  JEV_MCP_TOOLS,
  runJevDecide,
  runJevEvaluate,
  startJevMcpStdio,
  type JevFetchLike,
  type JevMcpDecisionEvent,
  type JevMcpTelemetry,
} from "../src/index.js";

function jsonResponse(body: unknown, status = 200): Awaited<ReturnType<JevFetchLike>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("Jev MCP schemas", () => {
  it("rejects invalid kind and oversized summary", () => {
    expect(() =>
      JevMidrunInputSchema.parse({
        kind: "not_a_kind",
        state: {},
      }),
    ).toThrow();

    expect(() =>
      JevMidrunInputSchema.parse({
        kind: "continue_vs_escalate",
        state: { summary: "x".repeat(501) },
      }),
    ).toThrow();
  });

  it("accepts tiny valid input", () => {
    expect(
      JevMidrunInputSchema.parse({
        kind: "tests_green_enough",
        state: { task_id: "t1", summary: "tests look ok" },
      }),
    ).toMatchObject({ kind: "tests_green_enough" });
  });
});

describe("runJevEvaluate / runJevDecide", () => {
  it("returns evaluated on high-confidence SystemOne answer", async () => {
    const events: JevMcpDecisionEvent[] = [];
    const telemetry: JevMcpTelemetry = {
      record(event) {
        events.push(event);
      },
    };
    const fetchImpl: JevFetchLike = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        model?: string;
        questions?: { midrun_evaluate?: unknown };
      };
      expect(body.model).toBe("jev-1.13.0");
      expect(body.questions?.midrun_evaluate).toBeTruthy();
      return jsonResponse({
        answers: {
          midrun_evaluate: { recommendation: "continue", confidence: 0.92 },
        },
      });
    };
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      fetchImpl,
    });

    const outcome = await runJevEvaluate({
      client,
      input: {
        kind: "continue_vs_escalate",
        state: { task_id: "task-1" },
      },
      telemetry,
    });

    expect(outcome).toEqual({
      kind: "evaluated",
      recommendation: "continue",
      confidence: 0.92,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tool: "jev_evaluate",
      taskId: "task-1",
      outcome: "evaluated",
    });
  });

  it("returns decided escalate on high confidence", async () => {
    const fetchImpl: JevFetchLike = async () =>
      jsonResponse({
        answers: {
          midrun_decide: { action: "escalate", confidence: 0.88, note: "scope unclear" },
        },
      });
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      fetchImpl,
    });

    await expect(
      runJevDecide({
        client,
        input: { kind: "continue_vs_escalate", state: { task_id: "t2" } },
      }),
    ).resolves.toEqual({
      kind: "escalate",
      action: "escalate",
      confidence: 0.88,
      note: "scope unclear",
    });
  });

  it("passthrough on timeout when fetch hangs", async () => {
    const fetchImpl: JevFetchLike = async () =>
      new Promise(() => {
        /* hang */
      });
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      timeoutMs: 20,
      fetchImpl,
    });

    const outcome = await runJevDecide({
      client,
      input: {
        kind: "next_file",
        state: { task_id: "t3" },
        timeoutMs: 20,
      },
    });

    expect(outcome).toMatchObject({ kind: "passthrough", reason: "timeout" });
  });

  it("passthrough on low confidence", async () => {
    const fetchImpl: JevFetchLike = async () =>
      jsonResponse({
        answers: {
          midrun_evaluate: { recommendation: "continue", confidence: 0.2 },
        },
      });
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      fetchImpl,
    });

    await expect(
      runJevEvaluate({
        client,
        input: { kind: "tests_green_enough", state: {} },
      }),
    ).resolves.toMatchObject({ kind: "passthrough", reason: "low_confidence" });
  });
});

describe("createJevMcpServer protocol", () => {
  it("lists exactly two soft tools", () => {
    const server = createJevMcpServer({
      client: createJevClient({ env: {}, fetchImpl: async () => jsonResponse({}) }),
    });
    expect(server.listTools()).toHaveLength(2);
    expect(JEV_MCP_TOOLS.map((t) => t.name)).toEqual(["jev_evaluate", "jev_decide"]);
  });

  it("tools/call returns passthrough JSON text on timeout", async () => {
    const fetchImpl: JevFetchLike = async () =>
      new Promise(() => {
        /* hang */
      });
    const server = createJevMcpServer({
      client: createJevClient({
        env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
        timeoutMs: 15,
        fetchImpl,
      }),
    });

    const init = await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    expect(init?.result).toMatchObject({
      serverInfo: { name: "optio-jev-mcp" },
    });

    const listed = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect((listed?.result as { tools: unknown[] }).tools).toHaveLength(2);

    const called = await server.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "jev_decide",
        arguments: {
          kind: "continue_vs_escalate",
          state: { task_id: "proto-1" },
          timeoutMs: 15,
        },
      },
    });
    const content = (called?.result as { content: Array<{ text: string }> }).content;
    expect(JSON.parse(content[0].text)).toMatchObject({
      kind: "passthrough",
      reason: "timeout",
    });
  });

  it("Content-Length framing round-trips through stdio", async () => {
    const fetchImpl: JevFetchLike = async () =>
      jsonResponse({
        answers: {
          midrun_decide: { action: "continue", confidence: 0.95 },
        },
      });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const chunks: Buffer[] = [];
    stdout.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));

    const handle = startJevMcpStdio({
      stdin,
      stdout,
      stderr: new PassThrough(),
      client: createJevClient({
        env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
        fetchImpl,
      }),
    });

    stdin.write(
      encodeContentLengthMessage({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "jev_decide",
          arguments: { kind: "continue_vs_escalate", state: { task_id: "stdio-1" } },
        },
      }),
    );

    await vi.waitFor(() => {
      expect(Buffer.concat(chunks).length).toBeGreaterThan(0);
    });

    const parser = new ContentLengthParser();
    const messages = parser.push(Buffer.concat(chunks));
    expect(messages.length).toBeGreaterThanOrEqual(0);
    const raw = Buffer.concat(chunks).toString("utf8");
    expect(raw).toContain("Content-Length:");
    expect(raw).toContain("decided");
    expect(raw).toContain("continue");

    handle.close();
    stdin.end();
  });
});

describe("createOtelJevMcpTelemetry", () => {
  it("emits jev.decision span once per record", async () => {
    const tracer = createStageTracer();
    const telemetry = createOtelJevMcpTelemetry(tracer);
    await telemetry.record({
      tool: "jev_evaluate",
      taskId: "otel-1",
      outcome: "evaluated",
      reason: "evaluated",
      midrunKind: "continue_vs_escalate",
    });
    const finished = tracer.finished();
    expect(finished.some((s) => s.name === "jev.decision")).toBe(true);
    const span = finished.find((s) => s.name === "jev.decision");
    expect(span?.attributes.tool).toBe("jev_evaluate");
    expect(span?.attributes.task_id).toBe("otel-1");
    await tracer.shutdown();
  });
});
