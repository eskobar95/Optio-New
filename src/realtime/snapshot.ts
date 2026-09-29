/**
 * Snapshot builder for (re)connect (ENG-40).
 */
import type { ActiveRunSnapshot, ChannelId, LiveEvent, SnapshotPayload } from "./types.js";

export interface SnapshotStore {
  listActiveRuns(channels: ReadonlySet<ChannelId>): ActiveRunSnapshot[];
}

export class InMemorySnapshotStore implements SnapshotStore {
  readonly #runs = new Map<string, ActiveRunSnapshot>();

  upsert(run: ActiveRunSnapshot): void {
    this.#runs.set(run.runId, run);
  }

  remove(runId: string): void {
    this.#runs.delete(runId);
  }

  listActiveRuns(channels: ReadonlySet<ChannelId>): ActiveRunSnapshot[] {
    const sessionIds = new Set<string>();
    let includeAll = false;
    for (const ch of channels) {
      if (ch.startsWith("session:")) {
        sessionIds.add(ch.slice("session:".length));
      } else if (ch === "system:status" || ch.startsWith("workspace:")) {
        includeAll = true;
      }
    }
    const out: ActiveRunSnapshot[] = [];
    for (const run of this.#runs.values()) {
      if (includeAll || sessionIds.has(run.sessionId)) {
        if (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled") {
          continue;
        }
        out.push(run);
      }
    }
    return out;
  }
}

export function buildSnapshotPayload(
  lastSeq: number,
  channels: readonly ChannelId[],
  store: SnapshotStore,
): SnapshotPayload {
  const set = new Set(channels);
  return {
    lastSeq,
    activeRuns: store.listActiveRuns(set),
    channels: [...channels],
  };
}

export function buildSnapshotEvent(
  seq: number,
  channel: ChannelId,
  ts: number,
  payload: SnapshotPayload,
): LiveEvent {
  return { type: "snapshot", seq, channel, ts, payload };
}
