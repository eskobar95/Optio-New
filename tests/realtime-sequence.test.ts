import { describe, expect, it } from "vitest";
import { CatchupBuffer, SequenceClock } from "../src/realtime/sequence.js";
import type { LiveEvent } from "../src/realtime/types.js";

function statusEvent(seq: number, sessionId = "s-1"): LiveEvent {
  return {
    type: "run.status",
    seq,
    channel: `session:${sessionId}`,
    ts: seq,
    payload: { runId: `r-${seq}`, sessionId, status: "running" },
  };
}

describe("SequenceClock", () => {
  it("allocates strictly monotonic 1-based seq values", () => {
    const clock = new SequenceClock();
    expect(clock.lastSeq).toBe(0);
    expect(clock.next()).toBe(1);
    expect(clock.next()).toBe(2);
    expect(clock.lastSeq).toBe(2);
  });

  it("rejects an invalid start", () => {
    expect(() => new SequenceClock(0)).toThrow();
  });
});

describe("CatchupBuffer", () => {
  it("returns only events after lastSeq", () => {
    const buf = new CatchupBuffer();
    buf.push(statusEvent(1));
    buf.push(statusEvent(2));
    buf.push(statusEvent(3));
    const { events, gap } = buf.catchup(1);
    expect(events.map((e) => e.seq)).toEqual([2, 3]);
    expect(gap).toBe(false);
  });

  it("filters by channel set", () => {
    const buf = new CatchupBuffer();
    buf.push(statusEvent(1, "a"));
    buf.push(statusEvent(2, "b"));
    const { events } = buf.catchup(0, new Set(["session:a"]));
    expect(events.map((e) => e.seq)).toEqual([1]);
  });

  it("reports a gap when the resume cursor fell out of the ring buffer", () => {
    const buf = new CatchupBuffer({ capacity: 2 });
    buf.push(statusEvent(10));
    buf.push(statusEvent(11));
    buf.push(statusEvent(12));
    const { gap, bufferOldestSeq } = buf.catchup(5);
    expect(gap).toBe(true);
    expect(bufferOldestSeq).toBe(11);
  });

  it("drops the oldest events past capacity", () => {
    const buf = new CatchupBuffer({ capacity: 2 });
    buf.push(statusEvent(1));
    buf.push(statusEvent(2));
    buf.push(statusEvent(3));
    expect(buf.size).toBe(2);
    expect(buf.catchup(0).events.map((e) => e.seq)).toEqual([2, 3]);
  });
});
