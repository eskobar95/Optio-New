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

export type FlueFetch = typeof fetch;

export interface FlueClientOptions {
  baseUrl?: string;
  fetchImpl?: FlueFetch;
  /** Max attempts for re-dispatch on network / 5xx. Default 3. */
  maxAttempts?: number;
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

export interface FlueClient {
  health(): Promise<FlueHealthResponse>;
  dispatch(body: FlueDispatchRequest): Promise<FlueDispatchResponse>;
  start(body: FlueStartRequest): Promise<FlueStartResponse>;
  /**
   * Dispatch then start. On network / timeout / 5xx, re-dispatches up to maxAttempts.
   * 4xx fails closed without retry.
   */
  dispatchAndStart(
    dispatchBody: FlueDispatchRequest,
    startExtras?: { taskId?: string },
  ): Promise<{ dispatch: FlueDispatchResponse; start: FlueStartResponse }>;
}

export function createFlueClient(options: FlueClientOptions = {}): FlueClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_FLUE_BASE_URL).replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_FLUE_MAX_ATTEMPTS);

  async function postJson<T>(path: string, body: unknown, parse: (raw: unknown) => T): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8", accept: "application/json" },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new FlueHttpError("flue request failed", {
        retryable: true,
        errorClass: "flue_network_error",
        cause,
      });
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

    try {
      return parse(json);
    } catch (cause) {
      throw new FlueHttpError("flue response failed schema validation", {
        statusCode: response.status,
        retryable: false,
        errorClass: "flue_schema_error",
        cause,
      });
    }
  }

  return {
    async health(): Promise<FlueHealthResponse> {
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/health`, {
          method: "GET",
          headers: { accept: "application/json" },
        });
      } catch (cause) {
        throw new FlueHttpError("flue health failed", {
          retryable: true,
          errorClass: "flue_network_error",
          cause,
        });
      }
      const json = (await response.json()) as unknown;
      if (!response.ok) {
        throw new FlueHttpError(`flue /health returned ${response.status}`, {
          statusCode: response.status,
          retryable: response.status >= 500,
          errorClass: "flue_server_error",
        });
      }
      return FlueHealthResponseSchema.parse(json);
    },

    async dispatch(body: FlueDispatchRequest): Promise<FlueDispatchResponse> {
      const request = FlueDispatchRequestSchema.parse(body);
      return postJson("/dispatch", request, (raw) => FlueDispatchResponseSchema.parse(raw));
    },

    async start(body: FlueStartRequest): Promise<FlueStartResponse> {
      const request = FlueStartRequestSchema.parse(body);
      return postJson("/start", request, (raw) => FlueStartResponseSchema.parse(raw));
    },

    async dispatchAndStart(dispatchBody, startExtras) {
      let lastError: FlueHttpError | undefined;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const dispatch = await this.dispatch(dispatchBody);
          const start = await this.start({
            sessionId: dispatch.sessionId,
            durableConversationId: dispatch.durableConversationId,
            taskId: startExtras?.taskId ?? dispatchBody.taskId,
          });
          return { dispatch, start };
        } catch (error) {
          if (!(error instanceof FlueHttpError) || !error.retryable || attempt >= maxAttempts) {
            throw error;
          }
          lastError = error;
        }
      }
      throw lastError ?? new FlueHttpError("flue re-dispatch exhausted", { retryable: false });
    },
  };
}
