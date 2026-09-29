/**
 * Multiplex realtime hub — one connection per window, many channel subscriptions (ENG-40).
 *
 * Does not touch Postgres transcript persistence (ENG-24); publishers may mirror
 * events to a separate consumer out of band.
 */
import { AuthError, type AuthPort, AllowAllAuth } from "./auth.js";
import { OutboundQueue } from "./backpressure.js";
import { ChannelParseError, parseChannelIds } from "./channels.js";
import { FrameDecodeError, decodeClientFrame, encodeFrame } from "./framing.js";
import { HeartbeatScheduler } from "./heartbeat.js";
import { type FanoutPort, InMemoryFanout } from "./fanout.js";
import { CatchupBuffer, SequenceClock } from "./sequence.js";
import {
  buildSnapshotEvent,
  buildSnapshotPayload,
  type SnapshotStore,
  InMemorySnapshotStore,
} from "./snapshot.js";
import type {
  ChannelId,
  ClientFrame,
  LiveEvent,
  OutboundFrame,
  ServerErrorFrame,
} from "./types.js";

/** Duplex transport for one window (WSS or test fake). */
export interface RealtimeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface RealtimeConnectionOptions {
  socket: RealtimeSocket;
  fanout?: FanoutPort;
  auth?: AuthPort;
  snapshotStore?: SnapshotStore;
  clock?: SequenceClock;
  catchup?: CatchupBuffer;
  now?: () => number;
  /** Require auth frame before subscribe. Default true when auth is not AllowAll. */
  requireAuth?: boolean;
  /** Auto-flush outbound queue after each enqueue (default true for sync tests). */
  autoFlush?: boolean;
  heartbeat?: boolean;
}

export class RealtimeConnection {
  readonly id: string;
  readonly subscriptions = new Set<ChannelId>();
  readonly outbound: OutboundQueue;
  readonly clock: SequenceClock;
  readonly catchup: CatchupBuffer;
  readonly snapshotStore: SnapshotStore;

  statusOnly = false;
  authenticated = false;
  subject: string | null = null;

  readonly #socket: RealtimeSocket;
  readonly #fanout: FanoutPort;
  readonly #auth: AuthPort;
  readonly #now: () => number;
  readonly #autoFlush: boolean;
  readonly #requireAuth: boolean;
  readonly #unsubFanout: () => void;
  readonly #heartbeat: HeartbeatScheduler | null;
  #closed = false;

  constructor(id: string, options: RealtimeConnectionOptions) {
    this.id = id;
    this.#socket = options.socket;
    this.#fanout = options.fanout ?? new InMemoryFanout();
    this.#auth = options.auth ?? new AllowAllAuth();
    this.snapshotStore = options.snapshotStore ?? new InMemorySnapshotStore();
    this.clock = options.clock ?? new SequenceClock();
    this.catchup = options.catchup ?? new CatchupBuffer();
    this.#now = options.now ?? Date.now;
    this.#autoFlush = options.autoFlush ?? true;
    this.#requireAuth = options.requireAuth ?? !(this.#auth instanceof AllowAllAuth);

    this.outbound = new OutboundQueue({
      send: (frame) => {
        if (this.#closed) return;
        this.#socket.send(encodeFrame(frame));
      },
    });

    this.#unsubFanout = this.#fanout.subscribe((event) => this.#onFanout(event));

    if (options.heartbeat) {
      this.#heartbeat = new HeartbeatScheduler({
        now: this.#now,
        nextSeq: () => this.clock.next(),
        onBeat: (event) => {
          this.catchup.push(event);
          this.#enqueue(event);
        },
      });
      this.#heartbeat.start();
    } else {
      this.#heartbeat = null;
    }

    if (!this.#requireAuth) {
      this.authenticated = true;
    }
  }

  /** Handle one inbound text frame from the socket. */
  handleMessage(raw: string): void {
    if (this.#closed) return;
    this.#heartbeat?.touch();
    let frame: ClientFrame;
    try {
      frame = decodeClientFrame(raw);
    } catch (err) {
      const message = err instanceof FrameDecodeError ? err.message : "invalid frame";
      this.#sendError("invalid_frame", message, 400);
      return;
    }
    void this.#dispatch(frame);
  }

  close(code = 1000, reason = "bye"): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#heartbeat?.stop();
    this.#unsubFanout();
    this.subscriptions.clear();
    this.outbound.clear();
    this.#socket.close(code, reason);
  }

  /** Publish a live event into the hub fan-out (and catchup buffer via local subscriber). */
  publish(event: Omit<LiveEvent, "seq"> & { seq?: number }): LiveEvent {
    const seq = event.seq ?? this.clock.next();
    const full: LiveEvent = { ...event, seq } as LiveEvent;
    this.catchup.push(full);
    void this.#fanout.publish(full);
    return full;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async #dispatch(frame: ClientFrame): Promise<void> {
    try {
      switch (frame.type) {
        case "auth":
          await this.#handleAuth(frame.token);
          break;
        case "subscribe":
          this.#ensureAuth();
          this.#handleSubscribe(frame.channels, frame.lastSeq);
          break;
        case "unsubscribe":
          this.#ensureAuth();
          this.#handleUnsubscribe(frame.channels);
          break;
        case "catchup":
          this.#ensureAuth();
          this.#handleCatchup(frame.lastSeq, frame.channels);
          break;
        case "ping":
          this.#enqueue({ type: "pong", ts: frame.ts ?? this.#now() });
          break;
        case "tab_focus":
          this.statusOnly = frame.focused === false && frame.statusOnly === true;
          break;
        case "cancel_run":
          // Cancel is a control signal for upstream runtime — hub only acks shape for now.
          this.#enqueue({
            type: "error",
            code: "cancel_not_wired",
            message: "cancel_run is accepted but not wired to a runtime in this transport layer",
            status: 501,
          });
          break;
        default:
          this.#sendError("unknown_type", "unsupported frame type", 400);
      }
    } catch (err) {
      if (err instanceof AuthError) {
        this.#sendError(err.code, err.message, err.status);
        if (err.status === 401) {
          this.close(4401, "unauthorized");
        }
        return;
      }
      if (err instanceof ChannelParseError) {
        this.#sendError(err.code, err.message, 400);
        return;
      }
      throw err;
    }
  }

  async #handleAuth(token: string): Promise<void> {
    const claims = await this.#auth.verify(token, this.#now());
    this.authenticated = true;
    this.subject = claims.subject;
    this.#enqueue({
      type: "auth.ack",
      expiresAt: claims.expiresAt,
    });
  }

  #ensureAuth(): void {
    if (this.#requireAuth && !this.authenticated) {
      throw new AuthError("auth required", 401, "auth_required");
    }
  }

  #handleSubscribe(rawChannels: readonly string[], lastSeq?: number): void {
    const channels = parseChannelIds(rawChannels);
    for (const ch of channels) {
      this.subscriptions.add(ch);
    }

    const ackLastSeq = this.clock.lastSeq;
    this.#enqueue({
      type: "subscribe.ack",
      channels: [...channels],
      lastSeq: ackLastSeq,
    });

    // Snapshot first, then catchup deltas when lastSeq provided.
    const snapshotPayload = buildSnapshotPayload(ackLastSeq, channels, this.snapshotStore);
    const snapChannel = channels[0]!;
    const snap = buildSnapshotEvent(this.clock.next(), snapChannel, this.#now(), snapshotPayload);
    this.catchup.push(snap);
    this.#enqueue(snap);

    if (lastSeq !== undefined) {
      this.#deliverCatchup(lastSeq, new Set(channels));
    }
  }

  #handleUnsubscribe(rawChannels: readonly string[]): void {
    const channels = parseChannelIds(rawChannels);
    for (const ch of channels) {
      this.subscriptions.delete(ch);
    }
    this.#enqueue({
      type: "unsubscribe.ack",
      channels: [...channels],
    });
  }

  #handleCatchup(lastSeq: number, rawChannels?: readonly string[]): void {
    const channelSet =
      rawChannels && rawChannels.length > 0
        ? new Set(parseChannelIds(rawChannels))
        : this.subscriptions;
    this.#deliverCatchup(lastSeq, channelSet);
  }

  #deliverCatchup(lastSeq: number, channels: ReadonlySet<ChannelId>): void {
    const { events, gap } = this.catchup.catchup(lastSeq, channels);
    if (gap) {
      const snapshotPayload = buildSnapshotPayload(
        this.clock.lastSeq,
        [...channels],
        this.snapshotStore,
      );
      const snap = buildSnapshotEvent(
        this.clock.next(),
        [...channels][0] ?? ("system:status" as ChannelId),
        this.#now(),
        snapshotPayload,
      );
      this.catchup.push(snap);
      this.#enqueue(snap);
    }
    for (const event of events) {
      if (event.type === "snapshot") continue;
      this.#enqueue(event);
    }
  }

  #onFanout(event: LiveEvent): void {
    if (this.#closed) return;
    if (!this.subscriptions.has(event.channel)) return;
    if (this.statusOnly && (event.type === "run.token" || event.type === "run.tool")) {
      return;
    }
    this.#enqueue(event);
  }

  #enqueue(frame: OutboundFrame): void {
    this.outbound.enqueue(frame);
    if (this.#autoFlush) this.outbound.flush();
  }

  #sendError(code: string, message: string, status?: number): void {
    const frame: ServerErrorFrame = { type: "error", code, message, status };
    this.#enqueue(frame);
  }
}

export interface RealtimeHubOptions {
  fanout?: FanoutPort;
  auth?: AuthPort;
  snapshotStore?: SnapshotStore;
  now?: () => number;
}

/**
 * Registry of window connections sharing one fan-out + sequence space.
 * One RealtimeConnection per browser tab / Tauri window — not per session.
 */
export class RealtimeHub {
  readonly fanout: FanoutPort;
  readonly clock = new SequenceClock();
  readonly catchup = new CatchupBuffer();
  readonly snapshotStore: SnapshotStore;
  readonly #auth: AuthPort;
  readonly #now: () => number;
  readonly #connections = new Map<string, RealtimeConnection>();
  #nextId = 1;

  constructor(options: RealtimeHubOptions = {}) {
    this.fanout = options.fanout ?? new InMemoryFanout();
    this.snapshotStore = options.snapshotStore ?? new InMemorySnapshotStore();
    this.#auth = options.auth ?? new AllowAllAuth();
    this.#now = options.now ?? Date.now;
  }

  get size(): number {
    return this.#connections.size;
  }

  attach(
    socket: RealtimeSocket,
    options: { requireAuth?: boolean; heartbeat?: boolean; autoFlush?: boolean } = {},
  ): RealtimeConnection {
    const id = `conn-${this.#nextId++}`;
    const conn = new RealtimeConnection(id, {
      socket,
      fanout: this.fanout,
      auth: this.#auth,
      snapshotStore: this.snapshotStore,
      clock: this.clock,
      catchup: this.catchup,
      now: this.#now,
      requireAuth: options.requireAuth,
      heartbeat: options.heartbeat,
      autoFlush: options.autoFlush,
    });
    this.#connections.set(id, conn);
    return conn;
  }

  detach(connectionId: string): void {
    const conn = this.#connections.get(connectionId);
    if (!conn) return;
    conn.close();
    this.#connections.delete(connectionId);
  }

  /** Publish a typed live event to all matching subscribers (and catchup buffer). */
  publish(partial: Omit<LiveEvent, "seq" | "ts"> & { ts?: number; seq?: number }): LiveEvent {
    const seq = partial.seq ?? this.clock.next();
    const ts = partial.ts ?? this.#now();
    const event = { ...partial, seq, ts } as LiveEvent;
    this.catchup.push(event);
    void this.fanout.publish(event);
    return event;
  }

  close(): void {
    for (const id of [...this.#connections.keys()]) {
      this.detach(id);
    }
    void this.fanout.close();
  }
}
