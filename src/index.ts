/**
 * Optio-New harness — TypeScript entry re-exports.
 * Language standard: TypeScript (Node 20+, ESM).
 */
export {
  cavemanRequested,
  createInstalledSkillLoader,
  DEFAULT_SKILL_BUDGET,
  runAgentLoop,
  type AgentLoopInput,
  type LoadedSkill,
  type ModelAdapter,
  type ModelRequest,
  type ModelResponse,
  type SkillBudget,
  type SkillLoader,
  type SkillResolveInput,
} from "./agent/loop.js";
export { createEnvModelAdapter, readModelEnv, type ModelEnvConfig } from "./agent/env-adapter.js";
export { buildIntakeJob, IntakeTaskSchema, type IntakeTask } from "./orchestrator/intake/index.js";
export { processHelloWorld } from "./orchestrator/jobs/hello-world.js";
export type { CodingAgent, CodingAgentInput, CodingAgentOutput } from "./adapters/coding-agent.js";
export { codexOpenAiBaseUrl } from "./adapters/codex/index.js";
export {
  litellmOrigin,
  loadCavemanProxyConfig,
  resolveCodexUpstreamBaseUrl,
  type CavemanMode,
  type CavemanProxyConfig,
} from "./proxy/index.js";
