/**
 * Optio-New harness — TypeScript entry re-exports.
 * Language standard: TypeScript (Node 20+, ESM).
 */
export {
  runAgentLoop,
  type AgentLoopInput,
  type ModelAdapter,
  type ModelRequest,
  type ModelResponse,
} from "./agent/loop.js";
export { createEnvModelAdapter, readModelEnv, type ModelEnvConfig } from "./agent/env-adapter.js";
export { buildIntakeJob, IntakeTaskSchema, type IntakeTask } from "./orchestrator/intake/index.js";
export { processHelloWorld } from "./orchestrator/jobs/hello-world.js";
export type { CodingAgent, CodingAgentInput, CodingAgentOutput } from "./adapters/coding-agent.js";
export {
  loadCavemanProxyConfig,
  resolveCodexUpstreamBaseUrl,
  type CavemanMode,
  type CavemanProxyConfig,
} from "./proxy/index.js";
