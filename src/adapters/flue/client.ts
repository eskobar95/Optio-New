/**
 * Thin Optio → Flue HTTP client. Inject `fetch` for unit tests (no real network).
 */

import {
  FlueDispatchRequestSchema,
  FlueDispatchResponseSchema,
  FlueHealthResponseSchema,
  FlueStartRequestSchema,
  FlueStartResponseSchema,
  type FlueDispatchRequest,
  type FlueDispatchResponse,
  type FlueHealthResponse,
  type FlueStartRequest,
  type FlueStartResponse,
} from "./contract.js";

export const DEFAULT_FLUE_BASE_URL = "http://127.0.0.1:3220";
export const DEFAULT_FLUE_MAX_ATTEMPTS = 3;
/** Per-request wall clock. Abort → retryable `flue_timeout`. */
export const DEFAULT_FLUE_TIMEOUT_MS = 60_000;

export type FlueFetch = typeof fetch;

export interface FlueClientOptions {
  baseUrl?: string;
  fetchImpl?: FlueFetch;
  /** Max attempts for dispatch/start on network / timeout / 5xx. Default 3. */
  maxAttempts?: number;
  /** AbortSignal.timeout budget per HTTP call. Default 60s. */
  timeoutMs?: number;
}

export class FlueHttpError extends Error {
  readonly statusCode: number | undefined;
  readonly retryable: boolean;
  readonly errorClass: string;

  constructor(
    message: string,
    options: { statusCode?: number; retryable: boolean; errorClass?: string; cause?: unknown },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "FlueHttpError";
    this.statusCode = options.statusCode;
    this.retryable = options.retryable;
    this.errorClass = options.errorClass ?? "flue_http_error";
  }
}

export function resolveFlueBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.FLUE_BASE_URL?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv.replace(/\/$/, "") : DEFAULT_FLUE_BASE_URL;
}

function isAbortError(cause: unknown): boolean {
  if (!cause || typeof cause !== "object") return false;
  const name = "name" in cause ? String(cause.name) : "";
  return name === "AbortError" || name === "TimeoutError";
}

function networkError(message: string, cause: unknown): FlueHttpError {
  if (isAbortError(cause)) {
    return new FlueHttpError(message, {
      retryable: true,
      errorClass: "flue_timeout",
      cause,
    });
  }
  return new FlueHttpError(message, {
    retryable: true,
    errorClass: "flue_network_error",
    cause,
  });
}

export interface FlueClient {
  health(): Promise<FlueHealthResponse>;
  dispatch(body: FlueDispatchRequest): Promise<FlueDispatchResponse>;
  start(body: FlueStartRequest): Promise<FlueStartResponse>;
  /**
   * Dispatch then start. On network / timeout / 5xx:
   * - if a session is already bound, retry `start` only (no orphan re-dispatch)
   * - otherwise retry `dispatch`
   * 4xx fails closed without retry.
   * `onDispatched` runs once after the first successful dispatch (before start).
   */
  dispatchAndStart(
    dispatchBody: FlueDispatchRequest,
    startExtras?: {
      taskId?: string;
      onDispatched?: (dispatch: FlueDispatchResponse) => void;
    },
  ): Promise<{ dispatch: FlueDispatchResponse; start: FlueStartResponse }>;
}

export function createFlueClient(options: FlueClientOptions = {}): FlueClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_FLUE_BASE_URL).replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_FLUE_MAX_ATTEMPTS);
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_FLUE_TIMEOUT_MS);

  async function request(
    path: string,
    init: { method: "GET" | "POST"; body?: unknown },
  ): Promise<{ status: number; json: unknown }> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: init.method,
        headers: {
          accept: "application/json",
          ...(init.body !== undefined ? { "content-type": "application/json; charset=utf-8" } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw networkError(`flue ${path} request failed`, cause);
    }

    const text = await response.text();
    let json: unknown = {};
    if (text.trim()) {
      try {
        json = JSON.parse(text) as unknown;
      } catch (cause) {
        throw new FlueHttpError("flue returned invalid JSON", {
          statusCode: response.status,
          retryable: response.status >= 500,
          errorClass: "flue_invalid_json",
          cause,
        });
      }
    }

    if (!response.ok) {
      const retryable = response.status >= 500;
      throw new FlueHttpError(`flue ${path} returned ${response.status}`, {
        statusCode: response.status,
        retryable,
        errorClass: retryable ? "flue_server_error" : "flue_client_error",
      });
    }

    return { status: response.status, json };
  }

  async function postJson<T>(path: string, body: unknown, parse: (raw: unknown) => T): Promise<T> {
    const { status, json } = await request(path, { method: "POST", body });
    try {
      return parse(json);
    } catch (cause) {
      throw new FlueHttpError("flue response failed schema validation", {
        statusCode: status,
        retryable: false,
        errorClass: "flue_schema_error",
        cause,
      });
    }
  }

  async function dispatch(body: FlueDispatchRequest): Promise<FlueDispatchResponse> {
    const requestBody = FlueDispatchRequestSchema.parse(body);
    return postJson("/dispatch", requestBody, (raw) => FlueDispatchResponseSchema.parse(raw));
  }

  async function start(body: FlueStartRequest): Promise<FlueStartResponse> {
    const requestBody = FlueStartRequestSchema.parse(body);
    return postJson("/start", requestBody, (raw) => FlueStartResponseSchema.parse(raw));
  }

  async function health(): Promise<FlueHealthResponse> {
    const { status, json } = await request("/health", { method: "GET" });
    try {
      return FlueHealthResponseSchema.parse(json);
    } catch (cause) {
      throw new FlueHttpError("flue /health failed schema validation", {
        statusCode: status,
        retryable: false,
        errorClass: "flue_schema_error",
        cause,
      });
    }
  }

  async function dispatchAndStart(
    dispatchBody: FlueDispatchRequest,
    startExtras?: {
      taskId?: string;
      onDispatched?: (dispatch: FlueDispatchResponse) => void;
    },
  ): Promise<{ dispatch: FlueDispatchResponse; start: FlueStartResponse }> {
    let bound: FlueDispatchResponse | undefined;
    let notified = false;
    let lastError: FlueHttpError | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (!bound) {
          bound = await dispatch(dispatchBody);
          if (!notified) {
            notified = true;
            startExtras?.onDispatched?.(bound);
          }
        }
        const started = await start({
          sessionId: bound.sessionId,
          durableConversationId: bound.durableConversationId,
          taskId: startExtras?.taskId ?? dispatchBody.taskId,
        });
        return { dispatch: bound, start: started };
      } catch (error) {
        if (!(error instanceof FlueHttpError) || !error.retryable || attempt >= maxAttempts) {
          throw error;
        }
        lastError = error;
        // Keep `bound` so the next attempt retries start only (avoids orphan sessions).
      }
    }

    throw lastError ?? new FlueHttpError("flue re-dispatch exhausted", { retryable: false });
  }

  return { health, dispatch, start, dispatchAndStart };
}
