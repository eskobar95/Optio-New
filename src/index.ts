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
  type AgentLoopResult,
  type AgentToolRuntime,
  type AuditEvent,
  type AuditSink,
  type DecisionSidecar,
  type GateDecision,
  type GuardedToolResult,
  type LoadedSkill,
  type ModelAdapter,
  type ModelRequest,
  type ModelResponse,
  type ModelToolCall,
  type SidecarAdvice,
  type SkillBudget,
  type SkillLoader,
  type SkillResolveInput,
} from "./agent/loop.js";
export {
  createStubDecisionSidecar,
  DEFAULT_TOOL_TIMEOUT_MS,
  evaluateHardGates,
} from "./harness/gates/index.js";
export { createEnvModelAdapter, readModelEnv, type ModelEnvConfig } from "./agent/env-adapter.js";
export { buildIntakeJob, IntakeTaskSchema, type IntakeTask } from "./orchestrator/intake/index.js";
export { processHelloWorld } from "./orchestrator/jobs/hello-world.js";
export {
  PIPELINE_JOB_ATTEMPTS,
  PIPELINE_STAGES,
  STAGE_QUEUES,
  STAGE_STEPS,
  StageNotReadyError,
  InMemoryStepCursorStore,
  buildPipelineFlow,
  bullmqStageWorkerFactory,
  createAgentStageHandler,
  createPgStepCursorStore,
  createSqlStepCursorStore,
  enqueueIntakePipeline,
  loadPipelineStepCursorDdl,
  processStageJob,
  runPipeline,
  startStageGraph,
  type FlowEnqueuer,
  type PipelineRunResult,
  type PipelineStage,
  type SqlExecutor,
  type StageJobResult,
  type StageRuntime,
  type StageStepContext,
  type StageStepHandler,
  type StageWorkerFactory,
  type StageWorkerHandle,
  type StepCursor,
  type StepCursorStore,
} from "./orchestrator/jobs/index.js";
export type {
  CodingAgent,
  CodingAgentInput,
  CodingAgentOutput,
  CodingAgentStatus,
  CodingAgentUsage,
} from "./adapters/coding-agent.js";
export {
  buildCodexGatewayConfig,
  codexAdapter,
  codexOpenAiBaseUrl,
  createCodexAdapter,
} from "./adapters/codex/index.js";
export {
  CURSOR_NATIVE_API_ENDPOINT,
  createCursorAdapter,
  cursorAdapter,
} from "./adapters/cursor/index.js";
export {
  CodingBackendUndecidedError,
  createCodingAgent,
  resolveCodingBackend,
  type CodingAgentDeps,
  type CodingBackendId,
  type CodingBackendSelection,
} from "./adapters/select.js";
export {
  litellmOrigin,
  loadCavemanProxyConfig,
  resolveCodexUpstreamBaseUrl,
  type CavemanMode,
  type CavemanProxyConfig,
} from "./proxy/index.js";
