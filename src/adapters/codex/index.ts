/**
 * Codex CLI CodingAgent (SPEC §13.2, §14.1–§14.2).
 * Writes a user-level config with `openai_base_url` aimed at LiteLLM
 * (or the local Caveman LiteLLM compat mount when that proxy is enabled).
 */

import path from "node:path";
import os from "node:os";

import {
  authorizeAgentRun,
  codexSandboxMode,
  type AgentSandbox,
} from "../../kit-harness/permissions.js";
import { loadCavemanProxyConfig, resolveCodexUpstreamBaseUrl } from "../../proxy/index.js";
import type { CodingAgent, CodingAgentInput, CodingAgentOutput } from "../coding-agent.js";
import {
  buildAgentPrompt,
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

/**
 * Codex `base_url` / `openai_base_url`.
 * Default: LiteLLM `/v1`. When `CAVEMAN_PROXY_ENABLED=true`: local Caveman
 * `/compat/litellm/v1`. Does not contact Caveman Platform or Cloud.
 */
export function codexOpenAiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const baseUrl = resolveCodexUpstreamBaseUrl(loadCavemanProxyConfig(env));
  if (!baseUrl) {
    throw new Error("codex upstream base URL is empty");
  }
  return baseUrl;
}

export interface CodexGatewayConfigOptions {
  modelId?: string;
  sandbox: "workspace-write" | "read-only" | "danger-full-access";
}

/** Runner-profile config. `env_key` names `LITELLM_MASTER_KEY`; the value stays in the environment. */
export function buildCodexGatewayConfig(
  baseUrl: string,
  options: CodexGatewayConfigOptions,
): string {
  const lines = [
    `openai_base_url = ${JSON.stringify(baseUrl)}`,
    `model_provider = "harness_gateway"`,
    `approval_policy = "never"`,
    `sandbox_mode = ${JSON.stringify(options.sandbox)}`,
  ];
  const model = options.modelId?.trim();
  if (model) lines.push(`model = ${JSON.stringify(model)}`);
  lines.push(
    "",
    "[model_providers.harness_gateway]",
    `name = "Optio-New gateway"`,
    `base_url = ${JSON.stringify(baseUrl)}`,
    `env_key = "LITELLM_MASTER_KEY"`,
    `wire_api = "responses"`,
    "",
  );
  return lines.join("\n");
}

function codexHomeFor(input: CodingAgentInput, deps: CodingAgentDeps): string {
  if (deps.codexHome?.trim()) return deps.codexHome;
  const task = input.metadata.task_id.replace(/[^a-zA-Z0-9._-]/g, "_");
  const step = input.metadata.step_id.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(os.tmpdir(), "optio-new-codex", task, step);
}

function codexRequest(
  input: CodingAgentInput,
  env: NodeJS.ProcessEnv,
  codexHome: string,
  baseUrl: string,
  sandbox: AgentSandbox,
): CliRunRequest {
  const command = env.CODEX_BIN?.trim() || "codex";
  const sandboxMode = codexSandboxMode(sandbox);
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-c",
    'approval_policy="never"',
    "--sandbox",
    sandboxMode,
  ];
  const model = input.metadata.model_id?.trim();
  if (model) args.push("-m", model);
  args.push(buildAgentPrompt(input));

  return {
    command,
    args,
    cwd: input.worktree_path,
    timeoutMs: input.budget.maxWallClockMs,
    env: childEnv(
      env,
      {
        CODEX_HOME: codexHome,
        OPENAI_BASE_URL: baseUrl,
      },
      ["CURSOR_API_KEY", "CURSOR_API_ENDPOINT"],
    ),
  };
}

async function defaultWriteTextFile(filePath: string, contents: string): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
}

export function createCodexAdapter(deps: CodingAgentDeps = {}): CodingAgent {
  return {
    id: "codex",
    async run(input: CodingAgentInput): Promise<CodingAgentOutput> {
      return withAgentRunSpan(input, "codex", deps.tracer, async () => {
        const auth = authorizeAgentRun({
          allowedTools: input.allowed_tools,
          permissionTier: input.permission_tier,
          stepId: input.metadata.step_id,
        });
        if (!auth.ok) return permissionDeniedRun("codex", input, auth.observation);

        const env = deps.env ?? process.env;
        const virtualKey = env.LITELLM_MASTER_KEY?.trim() ?? "";
        if (!virtualKey) {
          return credentialsFailure("codex", input, "missing_credentials");
        }

        let baseUrl: string;
        try {
          baseUrl = codexOpenAiBaseUrl(env);
        } catch (error) {
          return {
            pr_ready: false,
            status: "failed",
            error_class: "gateway_url",
            logs: error instanceof Error ? error.message : "codex upstream base URL is empty",
            usage: { provider: "codex", model_id: input.metadata.model_id },
          };
        }

        const sandbox = codexSandboxMode(auth.sandbox);
        const codexHome = codexHomeFor(input, deps);
        const configPath = path.join(codexHome, "config.toml");
        const config = buildCodexGatewayConfig(baseUrl, {
          modelId: input.metadata.model_id,
          sandbox,
        });
        const write = deps.writeTextFile ?? defaultWriteTextFile;
        try {
          await write(configPath, config);
        } catch (error) {
          return {
            pr_ready: false,
            status: "failed",
            error_class: "config_write",
            logs: error instanceof Error ? error.message : "failed to write codex config",
            usage: { provider: "codex", model_id: input.metadata.model_id },
          };
        }

        const result = await invokeCli(
          deps.runner ?? spawnCli,
          codexRequest(input, env, codexHome, baseUrl, auth.sandbox),
        );
        return mapCliToOutput({
          provider: "codex",
          input,
          result,
          secrets: [virtualKey],
        });
      });
    },
  };
}

export const codexAdapter: CodingAgent = createCodexAdapter();

export default codexAdapter;
