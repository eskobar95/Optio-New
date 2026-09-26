import type { CodingProvider, SessionQueueOutcome, SessionRejectionReason } from "./types.js";

/** Canonical span (SPEC §12.4). Attribute `queue_depth` is the provider wait gauge. */
export const SESSION_QUEUE_SPAN = "session.queue" as const;

/** Gauge: sessions waiting for a provider slot. */
export const SESSION_QUEUE_DEPTH_METRIC = "session.queue_depth" as const;

export interface SessionQueueSpan {
  name: typeof SESSION_QUEUE_SPAN;
  task_id: string;
  /** Empty string until a workspace is claimed (or after it is released). */
  worktree_id: string;
  attributes: {
    provider: CodingProvider;
    queue_depth: number;
    active: number;
    cap: number;
    outcome: SessionQueueOutcome;
    reason?: SessionRejectionReason;
  };
}

export interface SessionQueueDepthMetric {
  name: typeof SESSION_QUEUE_DEPTH_METRIC;
  value: number;
  attributes: {
    provider: CodingProvider;
    task_id: string;
    worktree_id: string;
    active: number;
    cap: number;
  };
}

/**
 * OTel seam. A collector adapter maps `emitSpan` to a span and `recordQueueDepth` to a gauge.
 * v1 ships no SDK; the names and attributes are the contract.
 */
export interface SessionTelemetry {
  emitSpan(span: SessionQueueSpan): void;
  recordQueueDepth(metric: SessionQueueDepthMetric): void;
}

export const noopSessionTelemetry: SessionTelemetry = {
  emitSpan() {},
  recordQueueDepth() {},
};

export class InMemorySessionTelemetry implements SessionTelemetry {
  readonly spans: SessionQueueSpan[] = [];
  readonly metrics: SessionQueueDepthMetric[] = [];

  emitSpan(span: SessionQueueSpan): void {
    this.spans.push(span);
  }

  recordQueueDepth(metric: SessionQueueDepthMetric): void {
    this.metrics.push(metric);
  }
}
