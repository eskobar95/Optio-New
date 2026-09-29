/**
 * Heartbeat / idle timeout helpers (ENG-40).
 */
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MAX_MS,
  HEARTBEAT_INTERVAL_MIN_MS,
  IDLE_TIMEOUT_MS,
  IDLE_TIMEOUT_MAX_MS,
  IDLE_TIMEOUT_MIN_MS,
} from "./constants.js";
import type { ChannelId, LiveEvent } from "./types.js";
import { systemStatusChannel } from "./channels.js";

export {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MAX_MS,
  HEARTBEAT_INTERVAL_MIN_MS,
  IDLE_TIMEOUT_MS,
  IDLE_TIMEOUT_MAX_MS,
  IDLE_TIMEOUT_MIN_MS,
};

export function isIdleTimedOut(
  lastActivityAt: number,
  now: number,
  idleMs = IDLE_TIMEOUT_MS,
): boolean {
  return now - lastActivityAt >= idleMs;
}

export function buildHeartbeatEvent(seq: number, ts: number, channel?: ChannelId): LiveEvent {
  return {
    type: "heartbeat",
    seq,
    channel: channel ?? systemStatusChannel(),
    ts,
    payload: { ts },
  };
}

export interface HeartbeatSchedulerOptions {
  intervalMs?: number;
  now?: () => number;
  onBeat: (event: LiveEvent) => void;
  nextSeq: () => number;
}

/**
 * Simple interval heartbeat. Call `touch()` on any inbound activity.
 * `checkIdle()` returns true when the connection should be closed.
 */
export class HeartbeatScheduler {
  readonly intervalMs: number;
  readonly #now: () => number;
  readonly #onBeat: (event: LiveEvent) => void;
  readonly #nextSeq: () => number;
  #timer: ReturnType<typeof setInterval> | null = null;
  lastActivityAt: number;

  constructor(options: HeartbeatSchedulerOptions) {
    this.intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
    if (
      this.intervalMs < HEARTBEAT_INTERVAL_MIN_MS ||
      this.intervalMs > HEARTBEAT_INTERVAL_MAX_MS
    ) {
      throw new Error(
        `heartbeat interval must be ${HEARTBEAT_INTERVAL_MIN_MS}–${HEARTBEAT_INTERVAL_MAX_MS}ms`,
      );
    }
    this.#now = options.now ?? Date.now;
    this.#onBeat = options.onBeat;
    this.#nextSeq = options.nextSeq;
    this.lastActivityAt = this.#now();
  }

  start(): void {
    this.stop();
    this.#timer = setInterval(() => {
      const ts = this.#now();
      this.#onBeat(buildHeartbeatEvent(this.#nextSeq(), ts));
    }, this.intervalMs);
    // Allow Node to exit if this is the only timer (tests / workers).
    if (typeof this.#timer === "object" && this.#timer !== null && "unref" in this.#timer) {
      (this.#timer as NodeJS.Timeout).unref();
    }
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  touch(at?: number): void {
    this.lastActivityAt = at ?? this.#now();
  }

  checkIdle(idleMs = IDLE_TIMEOUT_MS): boolean {
    return isIdleTimedOut(this.lastActivityAt, this.#now(), idleMs);
  }
}
