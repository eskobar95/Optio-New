/**
 * Optional Caveman local proxy wiring (pre-V1 cost-opt).
 * MIT skills live under `.cursor/skills/caveman*`.
 * The MIT CLI (`@caveman-ai/cli`) installs the BSL engine outside this repo.
 * Caveman Platform / Cloud is post-V1 — this module never calls it.
 */

export type CavemanMode = "compress" | "record";

export interface CavemanProxyConfig {
  /** True only when CAVEMAN_PROXY_ENABLED is the string "true". Default false. */
  enabled: boolean;
  /** Loopback listener from `caveman start`. Default http://127.0.0.1:8787. */
  url: string;
  mode: CavemanMode;
  /**
   * LiteLLM origin with no `/v1` suffix.
   * Direct Codex base URL when the proxy is off; compat upstream when it is on.
   */
  litellmBaseUrl: string;
}

const DEFAULT_PROXY_URL = "http://127.0.0.1:8787";
const DEFAULT_LITELLM_ORIGIN = "http://127.0.0.1:4000";
const LITELLM_COMPAT_PREFIX = "/compat/litellm";

function envOr(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const value = env[key]?.trim();
  return value ? value : fallback;
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

/** LiteLLM origin, even if the operator included a trailing `/v1`. */
export function litellmOrigin(baseUrl: string): string {
  const trimmed = stripTrailingSlashes(baseUrl.trim());
  if (trimmed.endsWith("/v1")) {
    return trimmed.slice(0, -"/v1".length);
  }
  return trimmed;
}

/**
 * Read optional Caveman proxy settings from env.
 * Default: disabled, loopback proxy, compress mode, local LiteLLM.
 */
export function loadCavemanProxyConfig(env: NodeJS.ProcessEnv = process.env): CavemanProxyConfig {
  const enabled = envOr(env, "CAVEMAN_PROXY_ENABLED", "false").toLowerCase() === "true";
  const url = stripTrailingSlashes(envOr(env, "CAVEMAN_PROXY_URL", DEFAULT_PROXY_URL));
  const modeRaw = envOr(env, "CAVEMAN_MODE", "compress").toLowerCase();
  const mode: CavemanMode = modeRaw === "record" ? "record" : "compress";
  const litellmBaseUrl = litellmOrigin(envOr(env, "LITELLM_BASE_URL", DEFAULT_LITELLM_ORIGIN));
  return { enabled, url, mode, litellmBaseUrl };
}

/**
 * Codex `model_providers.*.base_url` (Responses API, includes `/v1`).
 *
 * Disabled: direct LiteLLM (`directLiteLlmUrl` when passed, otherwise
 * `${LITELLM_BASE_URL}/v1`). Enabled: local proxy compat mount
 * `${CAVEMAN_PROXY_URL}/compat/litellm/v1`, which forwards to LiteLLM.
 * Returns null when the selected URL is empty.
 */
export function resolveCodexUpstreamBaseUrl(
  config: CavemanProxyConfig = loadCavemanProxyConfig(),
  directLiteLlmUrl?: string,
): string | null {
  if (!config.enabled) {
    if (directLiteLlmUrl !== undefined) {
      const direct = stripTrailingSlashes(directLiteLlmUrl.trim());
      return direct || null;
    }
    const origin = litellmOrigin(config.litellmBaseUrl);
    return origin ? `${origin}/v1` : null;
  }

  const proxy = stripTrailingSlashes(config.url.trim());
  if (!proxy) return null;
  if (proxy.endsWith(`${LITELLM_COMPAT_PREFIX}/v1`)) return proxy;
  if (proxy.endsWith(LITELLM_COMPAT_PREFIX)) return `${proxy}/v1`;
  return `${proxy}${LITELLM_COMPAT_PREFIX}/v1`;
}
