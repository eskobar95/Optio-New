/**
 * Shared secret redaction for orchestrator, eve, and adapters.
 * The implementation sits in the learning worker tree so that image can compile
 * with rootDir src/orchestrator/learning. kit-harness keeps an identical copy
 * because its image compiles only src/kit-harness.
 */
export {
  REDACTED,
  SECRET_ENV_NAMES,
  formatAgentDump,
  formatStageLog,
  redactError,
  redactSecrets,
  redactValue,
} from "../orchestrator/learning/redact.js";
