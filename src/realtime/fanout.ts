/**
 * Cross-node fan-out port (Redis/NATS optional). In-memory stub for tests (ENG-40).
 *
 * Persistence (ENG-24 Postgres transcript) is intentionally NOT wired here —
 * a parallel out-of-band consumer may subscribe to the same publish stream.
 */
import type { ChannelId, LiveEvent } from "./types.js";

export type FanoutHandler = (event: LiveEvent) => void;

export interface FanoutPort {
  publish(event: LiveEvent): Promise<void> | void;
  subscribe(handler: FanoutHandler): () => void;
  close(): Promise<void> | void;
}

/** In-process fan-out — single node / unit tests. */
export class InMemoryFanout implements FanoutPort {
  readonly #handlers = new Set<FanoutHandler>();

  publish(event: LiveEvent): void {
    for (const handler of [...this.#handlers]) {
      handler(event);
    }
  }

  subscribe(handler: FanoutHandler): () => void {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  close(): void {
    this.#handlers.clear();
  }
}

/**
 * Stub for a future Redis pub/sub or NATS adapter.
 * Channel subject prefix is injectable; no connection is opened here.
 */
export class StubBrokerFanout implements FanoutPort {
  readonly subjectPrefix: string;
  readonly published: LiveEvent[] = [];
  readonly #inner = new InMemoryFanout();

  constructor(subjectPrefix = "optio.realtime") {
    this.subjectPrefix = subjectPrefix;
  }

  subjectFor(channel: ChannelId): string {
    return `${this.subjectPrefix}.${channel}`;
  }

  publish(event: LiveEvent): void {
    this.published.push(event);
    this.#inner.publish(event);
  }

  subscribe(handler: FanoutHandler): () => void {
    return this.#inner.subscribe(handler);
  }

  close(): void {
    this.published.length = 0;
    this.#inner.close();
  }
}
