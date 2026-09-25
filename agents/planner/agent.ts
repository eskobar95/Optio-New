/**
 * Optio-New — planner phase agent (Eve root stub).
 * Owns plan + skill/specialist selection for a New Bot task session.
 */
export const agentId = "agents/planner" as const;

export const plannerAgent = {
  id: agentId,
  phase: "planner" as const,
  // model / tool policy / budget hooks wired by orchestrator at runtime
};

export default plannerAgent;
