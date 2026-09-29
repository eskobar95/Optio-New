/**
 * Realtime live-status timing and queue caps (ENG-40).
 * Tunables — not secrets or environment-specific IDs.
 */

/** App-level heartbeat interval (server → client), ms. */
export const HEARTBEAT_INTERVAL_MS = 25_000;

/** Allowed heartbeat range documented for operators. */
export const HEARTBEAT_INTERVAL_MIN_MS = 20_000;
export const HEARTBEAT_INTERVAL_MAX_MS = 30_000;

/**
 * Idle timeout: if no inbound frame (including pong/client ping) within this
 * window, the server closes the socket. Must exceed max heartbeat interval.
 */
export const IDLE_TIMEOUT_MS = 75_000;

/** Soft floor / ceiling for idle timeout documentation. */
export const IDLE_TIMEOUT_MIN_MS = 60_000;
export const IDLE_TIMEOUT_MAX_MS = 90_000;

/** Max outbound frames buffered per socket before backpressure kicks in. */
export const OUTBOUND_QUEUE_CAP = 1000;

/** Coalesce window for run.token frames under backpressure (ms). */
export const TOKEN_COALESCE_WINDOW_MS = 32;

/** Reconnect backoff: initial delay, max delay (ms). */
export const RECONNECT_INITIAL_MS = 500;
export const RECONNECT_MAX_MS = 30_000;

/** Catchup ring buffer size per publisher (events retained for lastSeq resume). */
export const CATCHUP_BUFFER_SIZE = 2048;
