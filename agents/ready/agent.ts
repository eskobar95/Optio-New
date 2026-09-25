/**
 * Optio-New — ready phase agent (Eve root stub).
 * Opens/updates PR; watches CI; moves Linear toward Ready.
 */
export const agentId = "agents/ready" as const;

export const readyAgent = {
  id: agentId,
  phase: "ready" as const,
};

export default readyAgent;
