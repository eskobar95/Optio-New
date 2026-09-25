/**
 * Optio-New — merge phase agent (Eve root stub).
 * Merges into development only when policy + CI allow; then worktree cleanup.
 */
export const agentId = "agents/merge" as const;

export const mergeAgent = {
  id: agentId,
  phase: "merge" as const,
};

export default mergeAgent;
