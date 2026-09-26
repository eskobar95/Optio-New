import type { CodingAgent, CodingAgentInput, CodingAgentOutput } from "../coding-agent.js";
import { loadCavemanProxyConfig, resolveCodexUpstreamBaseUrl } from "../../proxy/index.js";

/**
 * Codex `base_url` for `model_providers.harness_gateway`.
 * Default: LiteLLM `/v1`. When `CAVEMAN_PROXY_ENABLED=true`: local Caveman
 * `/compat/litellm/v1`. Does not contact Caveman Platform or Cloud.
 */
export function codexOpenAiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const baseUrl = resolveCodexUpstreamBaseUrl(loadCavemanProxyConfig(env));
  if (!baseUrl) {
    throw new Error("codex upstream base URL is empty");
  }
  return baseUrl;
}

/** Stub — Codex CLI → LiteLLM, optionally through the local Caveman proxy. */
export const codexAdapter: CodingAgent = {
  id: "codex",
  async run(_input: CodingAgentInput): Promise<CodingAgentOutput> {
    throw new Error("adapters/codex: not implemented (skeleton stub)");
  },
};

export default codexAdapter;
