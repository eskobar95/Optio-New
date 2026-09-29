/**
 * SSE fallback path — server → client only (ENG-40).
 *
 * Used when WSS is unavailable (proxies, restrictive networks) or on hosts that
 * cannot upgrade. The fallback deliberately carries only the **critical status
 * subset** — never `run.token` / `run.tool` — so read-only status stays live while
 * the full stream waits for WS to recover. The same typed schema is reused: a
 * `run.status` frame on SSE is byte-for-byte the same shape as on WSS.
 */
import { decodeOutboundFrame } from "./framing.js";
import type { LiveEvent, LiveEventType } from "./types.js";

/** Event types that may travel over the SSE fallback (tokens never do). */
export const SSE_STATUS_EVENT_TYPES: readonly LiveEventType[] = [
  "run.status",
  "run.error",
  "heartbeat",
  "snapshot",
];

const SSE_STATUS_SET = new Set<string>(SSE_STATUS_EVENT_TYPES);

export function isSseFallbackEvent(event: LiveEvent): boolean {
  return SSE_STATUS_SET.has(event.type);
}

/** One SSE wire frame: `event: <type>\ndata: <json>\n\n`. */
export function formatSseFrame(event: LiveEvent): string {
  if (!isSseFallbackEvent(event)) {
    throw new Error(`event type ${event.type} must not travel over the SSE fallback`);
  }
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export interface ParsedSseFrame {
  event: string;
  data: string;
}

/**
 * Parse a raw SSE chunk into frames. Comments (`:`), retry, and `id` fields are
 * ignored; unknown fields are dropped. Multi-line `data:` is joined with `\n`.
 */
export function parseSseChunk(chunk: string): ParsedSseFrame[] {
  const frames: ParsedSseFrame[] = [];
  for (const block of chunk.split(/\r?\n\r?\n/)) {
    if (block.trim().length === 0) continue;
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(":")) continue;
      const sep = line.indexOf(":");
      const field = sep === -1 ? line : line.slice(0, sep);
      const value = sep === -1 ? "" : line.slice(sep + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") dataLines.push(value);
    }
    if (dataLines.length > 0) frames.push({ event, data: dataLines.join("\n") });
  }
  return frames;
}

/** Decode an SSE `data:` payload into a live event, rejecting out-of-contract types. */
export function decodeSseEvent(data: string): LiveEvent {
  const frame = decodeOutboundFrame(data);
  if (!isSseFallbackEvent(frame as LiveEvent)) {
    throw new Error(`event type ${frame.type} is not part of the SSE fallback contract`);
  }
  return frame as LiveEvent;
}

/** Minimal EventSource surface (browser or test fake). */
export interface SseClient {
  close(): void;
  addEventListener(type: string, handler: (evt: { data: string }) => void): void;
  onerror?: () => void;
}

export interface SseStatusSourceOptions {
  open: (url: string) => SseClient;
  url: string;
  onEvent: (event: LiveEvent) => void;
  onError?: () => void;
}

/**
 * Read-only status consumer. On error the caller should retry WS first; this
 * source intentionally has no reconnect loop of its own (call `start()` again).
 */
export class SseStatusSource {
  readonly #options: SseStatusSourceOptions;
  #client: SseClient | null = null;

  constructor(options: SseStatusSourceOptions) {
    this.#options = options;
  }

  /** Safe to call again — closes any existing client first. */
  start(): void {
    this.stop();
    const client = this.#options.open(this.#options.url);
    this.#client = client;
    for (const type of SSE_STATUS_EVENT_TYPES) {
      client.addEventListener(type, (evt) => {
        try {
          this.#options.onEvent(decodeSseEvent(evt.data));
        } catch (error) {
          // Malformed/out-of-contract frame: surface it, keep the stream alive.
          this.#options.onError?.();
          void error;
        }
      });
    }
    client.onerror = () => {
      this.#options.onError?.();
    };
  }

  stop(): void {
    this.#client?.close();
    this.#client = null;
  }
}
