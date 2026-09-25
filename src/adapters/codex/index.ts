import type { CodingAgent, CodingAgentInput, CodingAgentOutput } from "../coding-agent.js";

/** Stub — Codex CLI → local LiteLLM gateway. */
export const codexAdapter: CodingAgent = {
  id: "codex",
  async run(_input: CodingAgentInput): Promise<CodingAgentOutput> {
    throw new Error("adapters/codex: not implemented (skeleton stub)");
  },
};

export default codexAdapter;
