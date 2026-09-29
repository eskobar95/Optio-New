import { describe, expect, it } from "vitest";
import {
  decideReconnect,
  nextReconnectDelayMs,
  shouldStopReconnect,
} from "../src/realtime/reconnect.js";
import { RECONNECT_INITIAL_MS, RECONNECT_MAX_MS } from "../src/realtime/constants.js";

describe("realtime reconnect policy", () => {
  it("stops the loop on 401 only", () => {
    expect(shouldStopReconnect(401)).toBe(true);
    expect(shouldStopReconnect(403)).toBe(false);
    expect(shouldStopReconnect(undefined)).toBe(false);
  });

  it("grows the backoff cap exponentially", () => {
    const full = { random: () => 1 };
    expect(nextReconnectDelayMs(0, full)).toBe(RECONNECT_INITIAL_MS);
    expect(nextReconnectDelayMs(1, full)).toBe(RECONNECT_INITIAL_MS * 2);
    expect(nextReconnectDelayMs(2, full)).toBe(RECONNECT_INITIAL_MS * 4);
    expect(nextReconnectDelayMs(20, full)).toBe(RECONNECT_MAX_MS);
  });

  it("applies full jitter in [0, cap)", () => {
    expect(nextReconnectDelayMs(3, { random: () => 0 })).toBe(0);
    const half = nextReconnectDelayMs(0, { random: () => 0.5 });
    expect(half).toBe(Math.floor(RECONNECT_INITIAL_MS * 0.5));
  });

  it("rejects a negative attempt", () => {
    expect(() => nextReconnectDelayMs(-1)).toThrow();
  });

  it("decideReconnect halts with a reason on 401", () => {
    expect(decideReconnect(2, 401)).toEqual({ stop: true, delayMs: 0, reason: "unauthorized" });
    const decision = decideReconnect(0, undefined, { random: () => 0 });
    expect(decision.stop).toBe(false);
    expect(decision.delayMs).toBe(0);
  });
});
