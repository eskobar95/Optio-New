/**
 * Optio-New — implementation phase agent (Eve root stub).
 * Codes in an isolated worktree; may call specialists.
 */
export const agentId = "agents/implementation" as const;

export const implementationAgent = {
  id: agentId,
  phase: "implementation" as const,
};

export default implementationAgent;
