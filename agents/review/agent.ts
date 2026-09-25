/**
 * Optio-New — review phase agent (Eve root stub).
 */
export const agentId = "agents/review" as const;

export const reviewAgent = {
  id: agentId,
  phase: "review" as const,
};

export default reviewAgent;
