/**
 * Per-socket outbound queue with token coalesce/drop under backpressure (ENG-40).
 * Status and error frames are never dropped.
 */
import { OUTBOUND_QUEUE_CAP } from "./constants.js";
import { isCriticalOutbound, isTokenEvent, type OutboundFrame } from "./types.js";

export interface BackpressureStats {
  enqueued: number;
  flushed: number;
  tokensDropped: number;
  tokensCoalesced: number;
  /** Heartbeats collapsed to the latest ts in the queue. */
  heartbeatsCoalesced: number;
  /** Non-critical, non-token frames (e.g. heartbeat) dropped under pressure. */
  expendableDropped: number;
  criticalForced: number;
  depth: number;
}

export interface OutboundQueueOptions {
  capacity?: number;
  send: (frame: OutboundFrame) => void;
}

/**
 * Bounded outbound buffer. Under pressure:
 * - Coalesce consecutive `run.token` for the same runId+sessionId into one (last text wins / concat short).
 * - Drop oldest non-critical frames (tokens) when still over capacity.
 * - Critical frames (status/error/acks) always enqueue; may evict tokens to make room.
 */
export class OutboundQueue {
  readonly capacity: number;
  readonly #send: (frame: OutboundFrame) => void;
  readonly #queue: OutboundFrame[] = [];
  #flushing = false;

  stats: BackpressureStats = {
    enqueued: 0,
    flushed: 0,
    tokensDropped: 0,
    tokensCoalesced: 0,
    heartbeatsCoalesced: 0,
    expendableDropped: 0,
    criticalForced: 0,
    depth: 0,
  };

  constructor(options: OutboundQueueOptions) {
    this.capacity = options.capacity ?? OUTBOUND_QUEUE_CAP;
    this.#send = options.send;
  }

  get depth(): number {
    return this.#queue.length;
  }

  enqueue(frame: OutboundFrame): void {
    this.stats.enqueued += 1;

    if (isTokenEvent(frame)) {
      const coalesced = this.#tryCoalesceToken(frame);
      if (coalesced) {
        this.stats.tokensCoalesced += 1;
        this.stats.depth = this.#queue.length;
        return;
      }
    } else if (frame.type === "heartbeat") {
      // Only the freshest heartbeat matters — collapse instead of queueing.
      const idx = this.#queue.findIndex((f) => f.type === "heartbeat");
      if (idx >= 0) {
        this.#queue[idx] = frame;
        this.stats.heartbeatsCoalesced += 1;
        return;
      }
    }

    if (this.#queue.length >= this.capacity) {
      if (isCriticalOutbound(frame)) {
        const dropped = this.#evictOldestToken();
        if (!dropped) {
          // Queue full of critical — still push critical (briefly over capacity).
          this.stats.criticalForced += 1;
        }
      } else if (isTokenEvent(frame)) {
        this.stats.tokensDropped += 1;
        this.stats.depth = this.#queue.length;
        return;
      } else {
        // Non-critical non-token (e.g. heartbeat): drop if full.
        this.stats.expendableDropped += 1;
        this.stats.depth = this.#queue.length;
        return;
      }
    }

    this.#queue.push(frame);
    this.stats.depth = this.#queue.length;
  }

  /** Flush all buffered frames synchronously (tests / immediate drain). */
  flush(): void {
    if (this.#flushing) return;
    this.#flushing = true;
    try {
      while (this.#queue.length > 0) {
        const next = this.#queue.shift()!;
        this.#send(next);
        this.stats.flushed += 1;
      }
    } finally {
      this.#flushing = false;
      this.stats.depth = this.#queue.length;
    }
  }

  clear(): void {
    this.#queue.length = 0;
    this.stats.depth = 0;
  }

  /**
   * Coalesce only with the immediately preceding frame when it is a matching
   * token. Looking further back would reorder text across intervening frames.
   */
  #tryCoalesceToken(frame: Extract<OutboundFrame, { type: "run.token" }>): boolean {
    const existing = this.#queue[this.#queue.length - 1];
    if (!existing || !isTokenEvent(existing)) return false;
    if (
      existing.payload.runId !== frame.payload.runId ||
      existing.payload.sessionId !== frame.payload.sessionId ||
      existing.channel !== frame.channel
    ) {
      return false;
    }
    const mergedText =
      existing.payload.text.length + frame.payload.text.length <= 4096
        ? existing.payload.text + frame.payload.text
        : frame.payload.text;
    // Keep the newer seq/ts so catchup ordering matches the latest token.
    this.#queue[this.#queue.length - 1] = {
      ...frame,
      payload: { ...frame.payload, text: mergedText },
    };
    return true;
  }

  #evictOldestToken(): boolean {
    const idx = this.#queue.findIndex((f) => isTokenEvent(f) || !isCriticalOutbound(f));
    if (idx < 0) return false;
    const removed = this.#queue.splice(idx, 1)[0];
    if (removed && isTokenEvent(removed)) {
      this.stats.tokensDropped += 1;
    } else if (removed) {
      this.stats.expendableDropped += 1;
    }
    return true;
  }
}
