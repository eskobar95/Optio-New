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
        // Non-critical non-token (e.g. heartbeat, tool): drop if full.
        this.stats.tokensDropped += 1;
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

  #tryCoalesceToken(frame: Extract<OutboundFrame, { type: "run.token" }>): boolean {
    for (let i = this.#queue.length - 1; i >= 0; i -= 1) {
      const existing = this.#queue[i];
      if (!isTokenEvent(existing)) continue;
      if (
        existing.payload.runId === frame.payload.runId &&
        existing.payload.sessionId === frame.payload.sessionId &&
        existing.channel === frame.channel
      ) {
        const mergedText =
          existing.payload.text.length + frame.payload.text.length <= 4096
            ? existing.payload.text + frame.payload.text
            : frame.payload.text;
        this.#queue[i] = {
          ...frame,
          payload: { ...frame.payload, text: mergedText },
          // Keep the newer seq so catchup ordering stays consistent with latest.
        };
        return true;
      }
      // Only coalesce against the most recent matching token; stop at first token mismatch batch.
      break;
    }
    return false;
  }

  #evictOldestToken(): boolean {
    const idx = this.#queue.findIndex((f) => isTokenEvent(f) || !isCriticalOutbound(f));
    if (idx < 0) return false;
    const removed = this.#queue.splice(idx, 1)[0];
    if (removed && (isTokenEvent(removed) || !isCriticalOutbound(removed))) {
      this.stats.tokensDropped += 1;
    }
    return true;
  }
}
