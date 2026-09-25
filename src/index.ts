/**
 * Optio-New harness — TypeScript entry re-exports.
 * Language standard: TypeScript (Node 20+, ESM).
 */
export { buildIntakeJob, IntakeTaskSchema, type IntakeTask } from "./orchestrator/intake/index.js";
export { processHelloWorld } from "./orchestrator/jobs/hello-world.js";
export type { CodingAgent, CodingAgentInput, CodingAgentOutput } from "./adapters/coding-agent.js";
