/**
 * Cursor CLI headless CodingAgent (SPEC §13.2, §14.1).
 * Subscription path only: CURSOR_API_KEY → https://api2.cursor.sh.
 * Does not set OPENAI_BASE_URL and does not MITM agent.v1.
 */

import type { CodingAgent, CodingAgentInput, CodingAgentOutput } from "../coding-agent.js";
import {
  authorizeAgentRun,
  cursorSandboxArgs,
  type AgentSandbox,
} from "../../kit-harness/permissions.js";
import {
  childEnv,
  credentialsFailure,
  invokeCli,
  mapCliToOutput,
  permissionDeniedRun,
  spawnCli,
  withAgentRunSpan,
  type CliRunRequest,
  type CodingAgentDeps,
} from "../runtime.js";
import { cursorImplementPrompt } from "./implement-feedback.js";

/** Native Cursor API host. Not a local LiteLLM or Caveman URL. */
export const CURSOR_NATIVE_API_ENDPOINT = "https://api2.cursor.sh";

const STRIP_FROM_CURSOR = [
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_BASE_URL",
  "LITELLM_BASE_URL",
  "LITELLM_MASTER_KEY",
  "CAVEMAN_PROXY_URL",
] as const;

/**
 * In-container runs set OPTIO_CURSOR_SANDBOX=disabled (Dockerfile and Compose).
 * That rewrites the tier's Cursor flags to `--sandbox disabled` (allowlist mode)
 * and keeps `--force` when the tier already adds it. Docker AppArmor cannot
 * start Cursor's user-namespace sandbox.
 * Unset keeps `cursorSandboxArgs`: read-only and workspace-write stay enabled;
 * host-admin stays `--force` with no sandbox flag.
 */
function cursorSandboxDisabled(env: NodeJS.ProcessEnv): boolean {
  const mode = env.OPTIO_CURSOR_SANDBOX?.trim().toLowerCase();
  return mode === "disabled" || mode === "allowlist";
}

function cursorLaunchArgs(env: NodeJS.ProcessEnv, sandbox: AgentSandbox): string[] {
  const args = cursorSandboxArgs(sandbox);
  if (!cursorSandboxDisabled(env)) return args;
  const kept = args.filter((arg) => arg !== "--sandbox" && arg !== "enabled");
  return ["--sandbox", "disabled", ...kept];
}

function cursorRequest(
  input: CodingAgentInput,
  env: NodeJS.ProcessEnv,
  sandbox: AgentSandbox,
): CliRunRequest {
  const command = env.CURSOR_AGENT_BIN?.trim() || "agent";
  const args = [
    "--print",
    "--output-format",
    "json",
    "--trust",
    "--workspace",
    input.worktree_path,
    ...cursorLaunchArgs(env, sandbox),
  ];
  const model = input.metadata.model_id?.trim();
  if (model) args.push("--model", model);
  args.push(cursorImplementPrompt(input));

  return {
    command,
    args,
    cwd: input.worktree_path,
    timeoutMs: input.budget.maxWallClockMs,
    env: childEnv(env, { CURSOR_API_ENDPOINT: CURSOR_NATIVE_API_ENDPOINT }, STRIP_FROM_CURSOR),
  };
}

export function createCursorAdapter(deps: CodingAgentDeps = {}): CodingAgent {
  return {
    id: "cursor",
    async run(input: CodingAgentInput): Promise<CodingAgentOutput> {
      return withAgentRunSpan(input, "cursor", deps.tracer, async () => {
        const auth = authorizeAgentRun({
          allowedTools: input.allowed_tools,
          permissionTier: input.permission_tier,
          stepId: input.metadata.step_id,
        });
        if (!auth.ok) return permissionDeniedRun("cursor", input, auth.observation);

        const env = deps.env ?? process.env;
        const apiKey = env.CURSOR_API_KEY?.trim() ?? "";
        if (!apiKey) {
          return credentialsFailure("cursor", input, "missing_credentials");
        }
        const result = await invokeCli(
          deps.runner ?? spawnCli,
          cursorRequest(input, env, auth.sandbox),
        );
        return mapCliToOutput({
          provider: "cursor",
          input,
          result,
          secrets: [apiKey],
        });
      });
    },
  };
}

export const cursorAdapter: CodingAgent = createCursorAdapter();

export default cursorAdapter;
