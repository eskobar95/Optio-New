/**
 * LiveEventSource — one normalized live stream per window (ENG-40).
 *
 * Two origins share the exact same typed event schema:
 * - Cloud sessions: WebSocket (WSS) via `LiveSocketEventSource`.
 * - Local MonoCode sessions: Tauri native IPC/events via `TauriLiveEventSource`.
 *
 * A local session must never double-stream the same bytes over both IPC and WS.
 * UI code consumes `onEvent` / `send` and does not care which origin is active.
 */
import { decodeOutboundFrame, encodeFrame } from "./framing.js";
import { decideReconnect, shouldStopReconnect, type ReconnectPolicyOptions } from "./reconnect.js";
import type { ChannelId, ClientFrame, LiveEvent, OutboundFrame } from "./types.js";

export type LiveEventSourceState = "idle" | "connecting" | "open" | "reconnecting" | "closed";

/** Minimal socket surface shared by browser WebSocket, `ws`, and test fakes. */
export interface LiveSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen?: () => void;
  onmessage?: (data: string) => void;
  /** `status` is an optional HTTP-like hint (e.g. 401) mapped by the transport. */
  onclose?: (code: number, reason: string, status?: number) => void;
}

export interface LiveEventSourceOptions {
  /** Open one socket per window — never one per session. */
  connect: () => LiveSocket;
  channels: ChannelId[];
  authToken?: string;
  reconnect?: ReconnectPolicyOptions;
  onEvent: (event: LiveEvent) => void;
  onState?: (state: LiveEventSourceState) => void;
  /** Reports transport-level failures (connect errors, protocol errors). */
  onTransportError?: (error: unknown) => void;
  /** Injectable scheduler so tests run without real timers. */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancelSchedule?: (handle: unknown) => void;
}

/**
 * Decodes outbound wire frames, tracks `lastSeq`, and forwards live events.
 * Control frames are returned so each transport can react on its own terms.
 */
export class LiveEventDispatcher {
  #lastSeq = 0;

  constructor(readonly onEvent: (event: LiveEvent) => void) {}

  get lastSeq(): number {
    return this.#lastSeq;
  }

  /** Reset the resume cursor (e.g. after a fresh snapshot replaces local state). */
  reset(lastSeq = 0): void {
    this.#lastSeq = lastSeq;
  }

  push(raw: string): OutboundFrame {
    const frame = decodeOutboundFrame(raw);
    if ("seq" in frame && typeof frame.seq === "number" && frame.seq > this.#lastSeq) {
      this.#lastSeq = frame.seq;
    }
    if (isLiveEvent(frame)) {
      this.onEvent(frame);
    }
    return frame;
  }
}

const CONTROL_TYPES = new Set<string>([
  "subscribe.ack",
  "unsubscribe.ack",
  "error",
  "pong",
  "auth.ack",
]);

export function isLiveEvent(frame: OutboundFrame): frame is LiveEvent {
  return !CONTROL_TYPES.has(frame.type);
}

/**
 * Cloud WebSocket transport. Handles auth on open, subscribe with `lastSeq`
 * catchup, backoff reconnect, and stops the loop on 401.
 */
export class LiveSocketEventSource {
  readonly dispatcher: LiveEventDispatcher;
  readonly #options: LiveEventSourceOptions;
  readonly #schedule: (fn: () => void, ms: number) => unknown;
  readonly #cancel: (handle: unknown) => void;
  readonly #channels: Set<ChannelId>;

  #socket: LiveSocket | null = null;
  #state: LiveEventSourceState = "idle";
  #attempt = 0;
  #timer: unknown = null;
  #stopped = false;

  constructor(options: LiveEventSourceOptions) {
    this.#options = options;
    this.#channels = new Set(options.channels);
    this.#schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms) as unknown);
    this.#cancel = options.cancelSchedule ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    this.dispatcher = new LiveEventDispatcher(options.onEvent);
  }

  get state(): LiveEventSourceState {
    return this.#state;
  }

  get lastSeq(): number {
    return this.dispatcher.lastSeq;
  }

  /** Open the socket (or start the reconnect loop). Safe to call again. */
  start(): void {
    this.#stopped = false;
    // Drop any pending reconnect so a second start() cannot race into two sockets.
    if (this.#timer !== null) {
      this.#cancel(this.#timer);
      this.#timer = null;
    }
    this.#attempt = 0;
    this.#open();
  }

  /** Stop reconnecting and close the current socket. */
  stop(code = 1000, reason = "client_stop"): void {
    this.#stopped = true;
    if (this.#timer !== null) {
      this.#cancel(this.#timer);
      this.#timer = null;
    }
    const socket = this.#socket;
    this.#socket = null;
    this.#setState("closed");
    socket?.close(code, reason);
  }

  /** Send a client control frame to the server. */
  send(frame: ClientFrame): void {
    this.#socket?.send(encodeFrame(frame));
  }

  /** Update the multiplex subscription set and inform the server. */
  subscribe(channels: readonly ChannelId[]): void {
    for (const ch of channels) this.#channels.add(ch);
    this.send({ type: "subscribe", channels: [...channels] });
  }

  unsubscribe(channels: readonly ChannelId[]): void {
    for (const ch of channels) this.#channels.delete(ch);
    this.send({ type: "unsubscribe", channels: [...channels] });
  }

  /** Requests status-only mode while the window/tab is in the background. */
  setFocused(focused: boolean): void {
    this.send({ type: "tab_focus", focused, statusOnly: !focused });
  }

  #open(): void {
    if (this.#stopped) return;
    this.#setState(this.#attempt === 0 ? "connecting" : "reconnecting");

    let socket: LiveSocket;
    try {
      socket = this.#options.connect();
    } catch (error) {
      this.#options.onTransportError?.(error);
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;

    socket.onopen = () => {
      this.#attempt = 0;
      this.#setState("open");
      if (this.#options.authToken) {
        this.send({ type: "auth", token: this.#options.authToken });
      }
      const lastSeq = this.dispatcher.lastSeq;
      this.send({
        type: "subscribe",
        channels: [...this.#channels],
        ...(lastSeq > 0 ? { lastSeq } : {}),
      });
    };

    socket.onmessage = (data) => {
      let frame: OutboundFrame;
      try {
        frame = this.dispatcher.push(data);
      } catch (error) {
        this.#options.onTransportError?.(error);
        return;
      }
      if (frame.type === "error" && shouldStopReconnect(frame.status)) {
        // Unauthorized: stop the reconnect loop and force re-login.
        this.stop(4401, "unauthorized");
      }
    };

    socket.onclose = (_code, _reason, status) => {
      this.#socket = null;
      if (this.#stopped) return;
      if (shouldStopReconnect(status)) {
        this.stop(4401, "unauthorized");
        return;
      }
      this.#scheduleReconnect(status);
    };
  }

  #scheduleReconnect(status?: number): void {
    const decision = decideReconnect(this.#attempt, status, this.#options.reconnect);
    if (decision.stop) {
      this.stop(4401, "unauthorized");
      return;
    }
    this.#attempt += 1;
    this.#setState("reconnecting");
    this.#timer = this.#schedule(() => {
      this.#timer = null;
      this.#open();
    }, decision.delayMs);
  }

  #setState(state: LiveEventSourceState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#options.onState?.(state);
  }
}

/**
 * Tauri IPC transport for local MonoCode sessions — no WebSocket, no network round-trip.
 * The host forwards serialized event payloads from the Rust runtime; the same
 * `LiveEventDispatcher` normalizes them, so renderer components are shared with cloud.
 */
export interface TauriEventBridge {
  /** Register a listener for the runtime event topic; resolves to an unlisten fn. */
  listen(event: string, handler: (payload: string) => void): Promise<() => void>;
  /** Send a control frame to the local runtime. */
  emit(event: string, payload: string): Promise<void> | void;
}

export const TAURI_EVENT_TOPIC = "optio://live";

export class TauriLiveEventSource {
  readonly dispatcher: LiveEventDispatcher;
  readonly #bridge: TauriEventBridge;
  readonly #onState: ((s: LiveEventSourceState) => void) | undefined;
  readonly #onTransportError: ((error: unknown) => void) | undefined;
  #unlisten: (() => void) | null = null;
  #state: LiveEventSourceState = "idle";

  constructor(
    bridge: TauriEventBridge,
    onEvent: (event: LiveEvent) => void,
    onState?: (s: LiveEventSourceState) => void,
    onTransportError?: (error: unknown) => void,
  ) {
    this.#bridge = bridge;
    this.dispatcher = new LiveEventDispatcher(onEvent);
    this.#onState = onState;
    this.#onTransportError = onTransportError;
  }

  get state(): LiveEventSourceState {
    return this.#state;
  }

  /** Safe to call again — replaces any existing listener. */
  async start(): Promise<void> {
    if (this.#unlisten) {
      this.#unlisten();
      this.#unlisten = null;
    }
    this.#setState("connecting");
    this.#unlisten = await this.#bridge.listen(TAURI_EVENT_TOPIC, (payload) => {
      try {
        this.dispatcher.push(payload);
      } catch (error) {
        this.#onTransportError?.(error);
      }
    });
    this.#setState("open");
  }

  async stop(): Promise<void> {
    this.#unlisten?.();
    this.#unlisten = null;
    this.#setState("closed");
  }

  send(frame: ClientFrame): void {
    void this.#bridge.emit(TAURI_EVENT_TOPIC, encodeFrame(frame));
  }

  #setState(state: LiveEventSourceState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#onState?.(state);
  }
}
