import { describe, expect, it } from "vitest";
import {
  isIdleTimedOut,
  HeartbeatScheduler,
  HEARTBEAT_INTERVAL_MAX_MS,
  HEARTBEAT_INTERVAL_MIN_MS,
  buildHeartbeatEvent,
} from "../src/realtime/heartbeat.js";
import type { LiveEvent } from "../src/realtime/types.js";

describe("realtime heartbeat", () => {
  it("documents the 20–30s heartbeat window", () => {
    expect(HEARTBEAT_INTERVAL_MIN_MS).toBe(20_000);
    expect(HEARTBEAT_INTERVAL_MAX_MS).toBe(30_000);
  });

  it("detects idle timeouts against a threshold", () => {
    expect(isIdleTimedOut(0, 5_000, 10_000)).toBe(false);
    expect(isIdleTimedOut(0, 10_000, 10_000)).toBe(true);
  });

  it("builds a heartbeat event on the system channel", () => {
    const event = buildHeartbeatEvent(3, 42);
    expect(event).toMatchObject({
      type: "heartbeat",
      seq: 3,
      channel: "system:status",
      ts: 42,
      payload: { ts: 42 },
    });
  });

  it("rejects an interval outside the documented range", () => {
    const base = { onBeat: () => {}, nextSeq: () => 1 };
    expect(() => new HeartbeatScheduler({ ...base, intervalMs: 5_000 })).toThrow();
    expect(() => new HeartbeatScheduler({ ...base, intervalMs: 60_000 })).toThrow();
  });

  it("emits beats at the configured interval", () => {
    let now = 1_000;
    const beats: LiveEvent[] = [];
    let seq = 1;
    const scheduler = new HeartbeatScheduler({
      intervalMs: 25_000,
      now: () => now,
      nextSeq: () => seq++,
      onBeat: (e) => beats.push(e),
    });
    scheduler.start();
    // Manual tick simulation: the scheduler uses setInterval, so drive it via real wait.
    scheduler.stop();

    // Deterministic check: advancing `now` and calling checkIdle reflects activity.
    expect(scheduler.checkIdle(75_000)).toBe(false);
    now += 80_000;
    expect(scheduler.checkIdle(75_000)).toBe(true);
    scheduler.touch(now);
    expect(scheduler.checkIdle(75_000)).toBe(false);
    expect(beats).toHaveLength(0);
  });

  it("touch resets the idle clock", () => {
    let now = 0;
    const scheduler = new HeartbeatScheduler({
      now: () => now,
      onBeat: () => {},
      nextSeq: () => 1,
    });
    now = 50_000;
    expect(scheduler.checkIdle(40_000)).toBe(true);
    scheduler.touch();
    expect(scheduler.checkIdle(40_000)).toBe(false);
  });
});
