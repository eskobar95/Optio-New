/**
 * Client reconnect policy: exponential backoff + jitter; 401 stops the loop (ENG-40).
 */
import { RECONNECT_INITIAL_MS, RECONNECT_MAX_MS } from "./constants.js";

export interface ReconnectPolicyOptions {
  initialMs?: number;
  maxMs?: number;
  /** Inject for tests; default Math.random in [0, 1). */
  random?: () => number;
}

export interface ReconnectDecision {
  /** Stop reconnecting (force re-login). */
  stop: boolean;
  /** Delay before next attempt when stop is false. */
  delayMs: number;
  reason?: string;
}

/**
 * HTTP-like status on a close/error frame. 401 → stop reconnect loop.
 */
export function shouldStopReconnect(status: number | undefined): boolean {
  return status === 401;
}

/**
 * Compute delay for attempt `attempt` (0-based) with full-jitter exponential backoff.
 * delay = random * min(max, initial * 2^attempt)
 */
export function nextReconnectDelayMs(
  attempt: number,
  options: ReconnectPolicyOptions = {},
): number {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new Error(`attempt must be a non-negative integer, got ${attempt}`);
  }
  const initial = options.initialMs ?? RECONNECT_INITIAL_MS;
  const max = options.maxMs ?? RECONNECT_MAX_MS;
  const random = options.random ?? Math.random;
  const exp = Math.min(max, initial * 2 ** attempt);
  return Math.floor(random() * exp);
}

export function decideReconnect(
  attempt: number,
  status: number | undefined,
  options: ReconnectPolicyOptions = {},
): ReconnectDecision {
  if (shouldStopReconnect(status)) {
    return { stop: true, delayMs: 0, reason: "unauthorized" };
  }
  return { stop: false, delayMs: nextReconnectDelayMs(attempt, options) };
}
