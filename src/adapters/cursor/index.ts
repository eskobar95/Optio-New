import type { CodingAgent, CodingAgentInput, CodingAgentOutput } from "../coding-agent.js";

/** Stub — Cursor CLI headless adapter (subscription only). */
export const cursorAdapter: CodingAgent = {
  id: "cursor",
  async run(_input: CodingAgentInput): Promise<CodingAgentOutput> {
    throw new Error("adapters/cursor: not implemented (skeleton stub)");
  },
};

export default cursorAdapter;
