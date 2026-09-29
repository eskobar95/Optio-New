import { describe, expect, it } from "vitest";
import {
  decodeSseEvent,
  formatSseFrame,
  isSseFallbackEvent,
  parseSseChunk,
  SseStatusSource,
  SSE_STATUS_EVENT_TYPES,
} from "../src/realtime/sse.js";
import type { LiveEvent } from "../src/realtime/types.js";

const statusEvent: LiveEvent = {
  type: "run.status",
  seq: 2,
  channel: "session:s-1",
  ts: 2,
  payload: { runId: "r-1", sessionId: "s-1", status: "running" },
};

const heartbeatEvent: LiveEvent = {
  type: "heartbeat",
  seq: 3,
  channel: "system:status",
  ts: 3,
  payload: { ts: 3 },
};

describe("SSE fallback contract", () => {
  it("allows only the status subset", () => {
    expect(SSE_STATUS_EVENT_TYPES).toEqual(["run.status", "run.error", "heartbeat", "snapshot"]);
    expect(isSseFallbackEvent(statusEvent)).toBe(true);
    const token: LiveEvent = {
      type: "run.token",
      seq: 1,
      channel: "session:s-1",
      ts: 1,
      payload: { runId: "r-1", sessionId: "s-1", text: "x" },
    };
    expect(isSseFallbackEvent(token)).toBe(false);
  });

  it("formats a frame and refuses to format tokens", () => {
    const frame = formatSseFrame(heartbeatEvent);
    expect(frame).toBe(`event: heartbeat\ndata: ${JSON.stringify(heartbeatEvent)}\n\n`);

    const token = { type: "run.token" } as unknown as LiveEvent;
    expect(() => formatSseFrame(token)).toThrow();
  });

  it("parses chunks into frames and ignores comments", () => {
    const chunk = `: keepalive\nevent: run.status\ndata: ${JSON.stringify(statusEvent)}\n\n`;
    const frames = parseSseChunk(chunk);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.event).toBe("run.status");
  });

  it("decodes a status event and rejects token/tool events", () => {
    expect(decodeSseEvent(JSON.stringify(statusEvent))).toEqual(statusEvent);
    const token = { type: "run.token", seq: 1, channel: "session:s-1", ts: 1, payload: {} };
    expect(() => decodeSseEvent(JSON.stringify(token))).toThrow();
  });

  it("forwards only status-class events through SseStatusSource", () => {
    const handlers = new Map<string, (evt: { data: string }) => void>();
    let closed = false;
    const received: LiveEvent[] = [];
    const source = new SseStatusSource({
      url: "https://api.test/realtime/status",
      open: () => ({
        close: () => {
          closed = true;
        },
        addEventListener: (type, handler) => handlers.set(type, handler),
      }),
      onEvent: (e) => received.push(e),
    });

    source.start();
    handlers.get("run.status")?.({ data: JSON.stringify(statusEvent) });
    expect(received).toHaveLength(1);

    // A token frame on the SSE channel is ignored, never forwarded.
    handlers.get("run.token")?.({ data: JSON.stringify({ type: "run.token" }) });
    expect(received).toHaveLength(1);

    source.stop();
    expect(closed).toBe(true);
  });

  it("start() is idempotent and closes the previous client", () => {
    let openCount = 0;
    let closeCount = 0;
    const source = new SseStatusSource({
      url: "https://api.test/realtime/status",
      open: () => {
        openCount += 1;
        return {
          close: () => {
            closeCount += 1;
          },
          addEventListener: () => {},
        };
      },
      onEvent: () => {},
    });

    source.start();
    source.start();
    // Second start must close the first client, not leak it.
    expect(openCount).toBe(2);
    expect(closeCount).toBe(1);
  });

  it("reports malformed frames via onError", () => {
    const handlers = new Map<string, (evt: { data: string }) => void>();
    let errors = 0;
    const source = new SseStatusSource({
      url: "https://api.test/realtime/status",
      open: () => ({
        close: () => {},
        addEventListener: (type, handler) => handlers.set(type, handler),
      }),
      onEvent: () => {},
      onError: () => {
        errors += 1;
      },
    });

    source.start();
    handlers.get("run.status")?.({ data: "not json" });
    expect(errors).toBe(1);
  });
});
