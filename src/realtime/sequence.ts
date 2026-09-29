/**
 * Monotonic sequence clock + catchup ring buffer (ENG-40).
 */
import { CATCHUP_BUFFER_SIZE } from "./constants.js";
import type { LiveEvent } from "./types.js";

export class SequenceClock {
  #next = 1;

  constructor(startAt = 1) {
    if (!Number.isInteger(startAt) || startAt < 1) {
      throw new Error(`SequenceClock startAt must be >= 1, got ${startAt}`);
    }
    this.#next = startAt;
  }

  /** Allocate next seq (1-based, monotonic). */
  next(): number {
    const seq = this.#next;
    this.#next += 1;
    return seq;
  }

  /** Last allocated seq, or 0 if none yet. */
  get lastSeq(): number {
    return this.#next - 1;
  }
}

export interface CatchupBufferOptions {
  capacity?: number;
}

/**
 * Retains recent live events for reconnect catchup (`seq > lastSeq`).
 * Does not store full transcripts — only the lightweight LiveEvent frames.
 */
export class CatchupBuffer {
  readonly capacity: number;
  readonly #events: LiveEvent[] = [];

  constructor(options: CatchupBufferOptions = {}) {
    this.capacity = options.capacity ?? CATCHUP_BUFFER_SIZE;
  }

  push(event: LiveEvent): void {
    this.#events.push(event);
    while (this.#events.length > this.capacity) {
      this.#events.shift();
    }
  }

  /**
   * Events with seq > lastSeq, optionally filtered by channel set.
   * If the gap exceeds the buffer (oldest seq > lastSeq + 1 when buffer full of newer),
   * returns `{ gap: true, events }` so the caller can send a fresh snapshot first.
   */
  catchup(
    lastSeq: number,
    channels?: ReadonlySet<string>,
  ): { events: LiveEvent[]; gap: boolean; bufferOldestSeq: number | null } {
    const filtered = this.#events.filter((e) => {
      if (e.seq <= lastSeq) return false;
      if (channels && channels.size > 0 && !channels.has(e.channel)) return false;
      return true;
    });

    const oldest = this.#events[0]?.seq ?? null;
    const gap =
      lastSeq > 0 &&
      oldest !== null &&
      lastSeq < oldest - 1 &&
      this.#events.length >= this.capacity;

    return { events: filtered, gap, bufferOldestSeq: oldest };
  }

  clear(): void {
    this.#events.length = 0;
  }

  get size(): number {
    return this.#events.length;
  }
}
