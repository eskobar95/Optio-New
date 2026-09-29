import { describe, expect, it } from "vitest";
import { OutboundQueue } from "../src/realtime/backpressure.js";
import type { LiveEvent, OutboundFrame } from "../src/realtime/types.js";

function token(runId: string, text: string, sessionId = "s-1"): LiveEvent {
  return {
    type: "run.token",
    seq: 1,
    channel: `session:${sessionId}`,
    ts: 1,
    payload: { runId, sessionId, text },
  };
}

function status(seq: number, sessionId = "s-1"): LiveEvent {
  return {
    type: "run.status",
    seq,
    channel: `session:${sessionId}`,
    ts: seq,
    payload: { runId: `r-${seq}`, sessionId, status: "running" },
  };
}

const heartbeat: LiveEvent = {
  type: "heartbeat",
  seq: 9,
  channel: "system:status",
  ts: 9,
  payload: { ts: 9 },
};

function makeQueue(capacity: number) {
  const sent: OutboundFrame[] = [];
  const queue = new OutboundQueue({ capacity, send: (f) => sent.push(f) });
  return { queue, sent };
}

describe("OutboundQueue backpressure", () => {
  it("coalesces consecutive tokens for the same run/channel", () => {
    const { queue, sent } = makeQueue(10);
    queue.enqueue(token("r-1", "Hel"));
    queue.enqueue(token("r-1", "lo"));
    expect(queue.depth).toBe(1);
    expect(queue.stats.tokensCoalesced).toBe(1);
    queue.flush();
    expect(sent).toHaveLength(1);
    expect((sent[0] as Extract<OutboundFrame, { type: "run.token" }>).payload.text).toBe("Hello");
  });

  it("does not coalesce tokens across different runs", () => {
    const { queue, sent } = makeQueue(10);
    queue.enqueue(token("r-1", "a"));
    queue.enqueue(token("r-2", "b"));
    queue.flush();
    expect(sent).toHaveLength(2);
  });

  it("drops tokens once the queue is at capacity", () => {
    const { queue } = makeQueue(2);
    queue.enqueue(token("r-1", "a"));
    queue.enqueue(token("r-2", "b"));
    queue.enqueue(token("r-3", "c"));
    expect(queue.depth).toBe(2);
    expect(queue.stats.tokensDropped).toBe(1);
  });

  it("never drops status/error frames — it evicts a token to make room", () => {
    const { queue, sent } = makeQueue(2);
    queue.enqueue(token("r-1", "a"));
    queue.enqueue(token("r-2", "b"));
    queue.enqueue(status(7));
    expect(queue.depth).toBe(2);
    queue.flush();
    expect(sent.some((f) => f.type === "run.status")).toBe(true);
  });

  it("keeps critical frames even when the queue is full of critical frames", () => {
    const { queue, sent } = makeQueue(1);
    queue.enqueue(status(1));
    queue.enqueue(status(2));
    expect(queue.stats.criticalForced).toBe(1);
    queue.flush();
    expect(sent.filter((f) => f.type === "run.status")).toHaveLength(2);
  });

  it("keeps critical status over expendable frames (heartbeat) under pressure", () => {
    const { queue, sent } = makeQueue(1);
    queue.enqueue(heartbeat);
    queue.enqueue(heartbeat);
    queue.enqueue(status(1));
    queue.flush();
    // Status always survives; the expendable heartbeat is evicted to make room.
    expect(sent.some((f) => f.type === "run.status")).toBe(true);
    expect(sent.filter((f) => f.type === "heartbeat")).toHaveLength(0);
  });

  it("clear() empties the buffer without sending", () => {
    const { queue, sent } = makeQueue(10);
    queue.enqueue(status(1));
    queue.clear();
    expect(queue.depth).toBe(0);
    expect(sent).toHaveLength(0);
  });
});
