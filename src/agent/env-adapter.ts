/**
 * Non-mock model adapter stub.
 * Reads MODEL_API_KEY and MODEL_ENDPOINT. complete() never performs HTTP.
 */

import type { ModelAdapter, ModelResponse } from "./adapter.js";

export interface ModelEnvConfig {
  apiKey: string | undefined;
  endpoint: string | undefined;
}

export function readModelEnv(
  env: Record<string, string | undefined> = process.env,
): ModelEnvConfig {
  return {
    apiKey: env.MODEL_API_KEY,
    endpoint: env.MODEL_ENDPOINT,
  };
}

export function createEnvModelAdapter(
  env: Record<string, string | undefined> = process.env,
): ModelAdapter {
  const config = readModelEnv(env);
  return {
    async complete(): Promise<ModelResponse> {
      if (!config.apiKey || !config.endpoint) {
        throw new Error("MODEL_API_KEY and MODEL_ENDPOINT are required");
      }
      throw new Error("Env model adapter stub does not perform HTTP");
    },
  };
}
