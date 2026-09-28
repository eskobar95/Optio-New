/**
 * Shared Jev SystemOne client for Optio soft gates (ENG-25).
 * Pin model jev-1.13.0. Callers choose fail-open (gates) vs fail-closed (Hop 2).
 *
 * Timeouts use AbortSignal **and** Promise.race so injected `fetchImpl` that
 * ignores `signal` still fail open/closed on schedule.
 */

import { resolveJevBaseUrl } from "./plugins/jev/index.js";
import { systemOneUrl, type FetchLike } from "./systemone.js";

/** Pinned Optio decision-layer model — never the Cursor session LLM. */
export const PINNED_JEV_MODEL = "jev-1.13.0";

/** Matches optio.stage_jev_gates.timeout_ms default. */
export const DEFAULT_JEV_TIMEOUT_MS = 30_000;

export type JevClientErrorReason = "timeout" | "http" | "network" | "invalid_url" | "invalid_body";

export type JevClientResult =
  | { ok: true; payload: unknown; status: number }
  | { ok: false; reason: JevClientErrorReason; status?: number; message?: string };

export type JevFetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface JevClientOptions {
  fetchImpl?: JevFetchLike | FetchLike;
  apiKey?: string;
  /** Defaults to PINNED_JEV_MODEL. */
  model?: string;
  timeoutMs?: number;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}

export interface PostSystemOneInput {
  state: Record<string, unknown>;
  questions: Record<string, unknown>;
  /** Per-call model override; falls back to client default. */
  model?: string;
  /** Per-call timeout override; falls back to client default. */
  timeoutMs?: number;
}

export interface JevClient {
  readonly model: string;
  readonly timeoutMs: number;
  postSystemOne(input: PostSystemOneInput): Promise<JevClientResult>;
}

function readApiKey(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.OPTIO_NEW_JEV_API_KEY || env.JEV_API_KEY;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

function timeoutError(ms: number): Error {
  const err = new Error(`Jev timed out after ${ms}ms`);
  err.name = "TimeoutError";
  return err;
}

/**
 * Thin POST /v1/systemone client with injectible fetch and hard timeout.
 * Does not interpret answers — gates and Hop-2 plugins own that.
 */
export function createJevClient(options: JevClientOptions = {}): JevClient {
  const env = options.env ?? process.env;
  const model = options.model?.trim() || PINNED_JEV_MODEL;
  const timeoutMs =
    typeof options.timeoutMs === "number" &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_JEV_TIMEOUT_MS;
  const apiKey = options.apiKey ?? readApiKey(env);
  const baseUrl = options.baseUrl?.trim() || resolveJevBaseUrl(env);
  const fetchImpl = (options.fetchImpl ?? fetch) as JevFetchLike;

  return {
    model,
    timeoutMs,
    async postSystemOne(input: PostSystemOneInput): Promise<JevClientResult> {
      let url: string;
      try {
        url = systemOneUrl(baseUrl);
      } catch (error) {
        return {
          ok: false,
          reason: "invalid_url",
          message: error instanceof Error ? error.message : "empty Jev base URL",
        };
      }

      const headers: Record<string, string> = { "content-type": "application/json" };
      if (apiKey) {
        headers.authorization = `Bearer ${apiKey}`;
      }

      const body: Record<string, unknown> = {
        state: input.state,
        questions: input.questions,
        model: input.model?.trim() || model,
      };

      const callTimeout =
        typeof input.timeoutMs === "number" &&
        Number.isFinite(input.timeoutMs) &&
        input.timeoutMs > 0
          ? input.timeoutMs
          : timeoutMs;

      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;

      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(timeoutError(callTimeout));
        }, callTimeout);
      });

      const run = async (): Promise<JevClientResult> => {
        const response = await fetchImpl(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok) {
          return { ok: false, reason: "http", status: response.status };
        }
        try {
          return { ok: true, payload: await response.json(), status: response.status };
        } catch (error) {
          return {
            ok: false,
            reason: "invalid_body",
            status: response.status,
            message: error instanceof Error ? error.message : "invalid JSON body",
          };
        }
      };

      try {
        return await Promise.race([run(), deadline]);
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) {
          return { ok: false, reason: "timeout", message: `Jev timed out after ${callTimeout}ms` };
        }
        return {
          ok: false,
          reason: "network",
          message: error instanceof Error ? error.message : "upstream unreachable",
        };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}
