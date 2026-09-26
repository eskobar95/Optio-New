/**
 * Optional Caveman local proxy wiring (pre-V1 cost-opt).
 * MIT skill lives under `.cursor/skills/caveman*`.
 * Runtime CLI (@caveman-ai/cli) is NOT vendored — install separately.
 * Caveman Platform / Cloud managed gateway is post-V1 — do not require it.
 */

export type CavemanMode = "compress" | "record";

export interface CavemanProxyConfig {
  enabled: boolean;
  url: string;
  mode: CavemanMode;
}

/** Read optional Caveman proxy settings from env. Default: disabled. */
export function loadCavemanProxyConfig(env: NodeJS.ProcessEnv = process.env): CavemanProxyConfig {
  const enabled = (env.CAVEMAN_PROXY_ENABLED ?? "false").toLowerCase() === "true";
  const url = env.CAVEMAN_PROXY_URL ?? "http://127.0.0.1:8787";
  const modeRaw = (env.CAVEMAN_MODE ?? "compress").toLowerCase();
  const mode: CavemanMode = modeRaw === "record" ? "record" : "compress";
  return { enabled, url, mode };
}

/**
 * When enabled, Codex / LiteLLM upstream should target this base URL
 * (e.g. openai_base_url / OPENAI_BASE_URL). When disabled, return null —
 * callers keep the direct LiteLLM path unchanged.
 */
export function resolveCodexUpstreamBaseUrl(
  config: CavemanProxyConfig = loadCavemanProxyConfig(),
  directLiteLlmUrl?: string,
): string | null {
  if (!config.enabled) {
    return directLiteLlmUrl ?? null;
  }
  return config.url.replace(/\/$/, "");
}
