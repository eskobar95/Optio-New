import { describe, expect, it } from "vitest";

import type { CodingAgentInput } from "../src/adapters/coding-agent.js";
import {
  CodingBackendUndecidedError,
  createCodingAgent,
  resolveCodingBackend,
} from "../src/adapters/select.js";
import { CURSOR_NATIVE_API_ENDPOINT } from "../src/adapters/cursor/index.js";
import { CURSOR_IMPLEMENT_ACI_POLICY } from "../src/adapters/cursor/implement-feedback.js";
import { spawnCli, type CliRunRequest, type CliRunResult } from "../src/adapters/runtime.js";

const PROMPT = "implement the seam";
const INSTRUCTIONS = "follow the spec";
const EXPECTED_PROMPT = `${INSTRUCTIONS}\n\n${PROMPT}`;
const CURSOR_IMPLEMENT_PROMPT = `${EXPECTED_PROMPT}\n\n${CURSOR_IMPLEMENT_ACI_POLICY}`;
const LITELLM_URL = "http://127.0.0.1:4000/v1";
const CAVEMAN_URL = "http://127.0.0.1:8787/compat/litellm/v1";
const CURSOR_KEY = "cursor-key-secret";
const LITELLM_KEY = "litellm-master-secret";

function sampleInput(overrides: Partial<CodingAgentInput> = {}): CodingAgentInput {
  return {
    worktree_path: "/tmp/wt-task",
    prompt: PROMPT,
    instructions: INSTRUCTIONS,
    allowed_tools: ["edit", "shell"],
    budget: { maxWallClockMs: 1000 },
    metadata: {
      task_id: "t-9",
      worktree_id: "wt-9",
      workflow_id: "default-task",
      step_id: "implementation",
      agent_id: "agents/implementation",
      model_id: "gpt-4o",
    },
    ...overrides,
  };
}

function fakeRunner(result: Partial<CliRunResult>) {
  const calls: CliRunRequest[] = [];
  return {
    calls,
    runner: async (request: CliRunRequest): Promise<CliRunResult> => {
      calls.push(request);
      return {
        exitCode: result.exitCode ?? 0,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        timedOut: result.timedOut ?? false,
        signal: result.signal ?? null,
      };
    },
  };
}

describe("coding backend selection", () => {
  it("fails closed when coding_backend is unset", () => {
    expect(() => resolveCodingBackend({})).toThrow(CodingBackendUndecidedError);
    expect(() => resolveCodingBackend({ stepCodingBackend: "  ", defaultBackend: "" })).toThrow(
      /unset/,
    );
  });

  it("fails closed for an unknown backend", () => {
    expect(() => resolveCodingBackend({ stepCodingBackend: "claude" })).toThrow(
      CodingBackendUndecidedError,
    );
    expect(() => resolveCodingBackend({ defaultBackend: "Cursor" })).toThrow(/not a known adapter/);
  });

  it("uses the step backend over the global default", () => {
    expect(resolveCodingBackend({ stepCodingBackend: "cursor", defaultBackend: "codex" })).toBe(
      "cursor",
    );
    expect(resolveCodingBackend({ stepCodingBackend: "", defaultBackend: "codex" })).toBe("codex");
  });
});

describe("Cursor CodingAgent", () => {
  it("runs headless on the subscription endpoint and omits the model proxy", async () => {
    const { runner, calls } = fakeRunner({
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "edited files",
      }),
    });
    const agent = createCodingAgent(resolveCodingBackend({ stepCodingBackend: "cursor" }), {
      runner,
      env: {
        CURSOR_API_KEY: CURSOR_KEY,
        OPENAI_BASE_URL: LITELLM_URL,
        CURSOR_API_ENDPOINT: "http://127.0.0.1:9999",
        LITELLM_MASTER_KEY: LITELLM_KEY,
        PATH: "/usr/bin",
      },
    });

    const output = await agent.run(sampleInput());

    expect(agent.id).toBe("cursor");
    expect(output.status).toBe("succeeded");
    expect(output.pr_ready).toBe(false);
    expect(output.usage).toEqual({ provider: "cursor", model_id: "gpt-4o" });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.command).toBe("agent");
    expect(call?.cwd).toBe("/tmp/wt-task");
    expect(call?.timeoutMs).toBe(1000);
    expect(call?.args.slice(0, 6)).toEqual([
      "--print",
      "--output-format",
      "json",
      "--trust",
      "--workspace",
      "/tmp/wt-task",
    ]);
    expect(call?.args).toContain("--force");
    expect(call?.args).toContain("--sandbox");
    expect(call?.args).toContain("enabled");
    expect(call?.args).toContain("--model");
    expect(call?.args.at(-1)).toBe(CURSOR_IMPLEMENT_PROMPT);
    expect(call?.args.join(" ")).not.toContain(CURSOR_KEY);
    expect(call?.args.join(" ")).not.toContain("127.0.0.1");
    expect(call?.env.OPENAI_BASE_URL).toBeUndefined();
    expect(call?.env.LITELLM_MASTER_KEY).toBeUndefined();
    expect(call?.env.CURSOR_API_ENDPOINT).toBe(CURSOR_NATIVE_API_ENDPOINT);
    expect(call?.env.CURSOR_API_KEY).toBe(CURSOR_KEY);
    expect(call?.env.PATH).toBe("/usr/bin");
  });

  it("maps Cursor camelCase usage and fills missing cost_usd as 0", async () => {
    const { runner } = fakeRunner({
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "pong",
        usage: {
          inputTokens: 100,
          outputTokens: 7,
          cacheReadTokens: 12,
          cacheWriteTokens: 0,
        },
      }),
    });
    const agent = createCodingAgent("cursor", {
      runner,
      env: { CURSOR_API_KEY: CURSOR_KEY },
    });
    const output = await agent.run(sampleInput());
    expect(output.status).toBe("succeeded");
    expect(output.usage).toEqual({
      provider: "cursor",
      input_tokens: 100,
      output_tokens: 7,
      cached_tokens: 12,
      cost_usd: 0,
    });
  });

  it("returns usage and status from the CLI json", async () => {
    const { runner } = fakeRunner({
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        diff_summary: "src/a.ts | 2 +",
        usage: {
          input_tokens: 11,
          output_tokens: 22,
          cached_tokens: 3,
          cost_usd: 0.04,
          model_id: "composer-2",
        },
      }),
    });
    const agent = createCodingAgent("cursor", {
      runner,
      env: { CURSOR_API_KEY: CURSOR_KEY },
    });

    const output = await agent.run(sampleInput({ budget: { maxTokens: 40, maxUsd: 1 } }));

    expect(output.status).toBe("succeeded");
    expect(output.diff_summary).toBe("src/a.ts | 2 +");
    expect(output.usage).toEqual({
      provider: "cursor",
      model_id: "composer-2",
      input_tokens: 11,
      output_tokens: 22,
      cached_tokens: 3,
      cost_usd: 0.04,
    });
  });

  it("maps a 429 to rate_limited and a token overrun to budget_exhausted", async () => {
    const limited = fakeRunner({ exitCode: 1, stderr: "HTTP 429 Too Many Requests" });
    const limitedAgent = createCodingAgent("cursor", {
      runner: limited.runner,
      env: { CURSOR_API_KEY: CURSOR_KEY },
    });
    const limitedOutput = await limitedAgent.run(sampleInput());
    expect(limitedOutput.status).toBe("rate_limited");
    expect(limitedOutput.error_class).toBe("rate_limited");
    expect(limitedOutput.usage.provider).toBe("cursor");

    const over = fakeRunner({
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        usage: { input_tokens: 11, output_tokens: 22 },
      }),
    });
    const overAgent = createCodingAgent("cursor", {
      runner: over.runner,
      env: { CURSOR_API_KEY: CURSOR_KEY },
    });
    const overOutput = await overAgent.run(sampleInput({ budget: { maxTokens: 30 } }));
    expect(overOutput.status).toBe("budget_exhausted");
    expect(overOutput.error_class).toBe("token_budget");
    expect(overOutput.usage.input_tokens).toBe(11);
    expect(overOutput.usage.output_tokens).toBe(22);
  });

  it("does not spawn when CURSOR_API_KEY is missing", async () => {
    const { runner, calls } = fakeRunner({});
    const agent = createCodingAgent("cursor", { runner, env: {} });
    const output = await agent.run(sampleInput());
    expect(output.status).toBe("failed");
    expect(output.error_class).toBe("missing_credentials");
    expect(output.usage.provider).toBe("cursor");
    expect(calls).toHaveLength(0);
  });

  it("keeps read-only runs off --force", async () => {
    const { runner, calls } = fakeRunner({
      stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    });
    const agent = createCodingAgent("cursor", {
      runner,
      env: { CURSOR_API_KEY: CURSOR_KEY },
    });
    await agent.run(sampleInput({ allowed_tools: ["read"] }));
    expect(calls[0]?.args).not.toContain("--force");
    expect(calls[0]?.args).toContain("--sandbox");
    expect(calls[0]?.args).toContain("enabled");
  });

  it("disables the Cursor sandbox inside the orchestrator container", async () => {
    const readOnly = fakeRunner({
      stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    });
    const review = createCodingAgent("cursor", {
      runner: readOnly.runner,
      env: { CURSOR_API_KEY: CURSOR_KEY, OPTIO_CURSOR_SANDBOX: "disabled" },
    });
    await review.run(sampleInput({ allowed_tools: ["read"] }));
    // --force is required: allowlist without a TTY blocks git on read-only review.
    expect(readOnly.calls[0]?.args).toContain("--force");
    expect(readOnly.calls[0]?.args).toContain("--sandbox");
    expect(readOnly.calls[0]?.args).toContain("disabled");
    expect(readOnly.calls[0]?.args).not.toContain("enabled");

    const write = fakeRunner({
      stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    });
    const implement = createCodingAgent("cursor", {
      runner: write.runner,
      env: { CURSOR_API_KEY: CURSOR_KEY, OPTIO_CURSOR_SANDBOX: " allowlist " },
    });
    await implement.run(sampleInput());
    expect(write.calls[0]?.args).toContain("--force");
    expect(write.calls[0]?.args).toContain("--sandbox");
    expect(write.calls[0]?.args).toContain("disabled");
    expect(write.calls[0]?.args).not.toContain("enabled");

    const host = fakeRunner({
      stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    });
    const hostAgent = createCodingAgent("cursor", {
      runner: host.runner,
      env: { CURSOR_API_KEY: CURSOR_KEY, OPTIO_CURSOR_SANDBOX: "disabled" },
    });
    await hostAgent.run(
      sampleInput({
        allowed_tools: ["docker"],
        permission_tier: "host-admin",
      }),
    );
    expect(host.calls[0]?.args).toContain("--force");
    expect(host.calls[0]?.args).toContain("--sandbox");
    expect(host.calls[0]?.args).toContain("disabled");
  });
});

describe("Codex CodingAgent", () => {
  it("writes openai_base_url at local LiteLLM and returns usage", async () => {
    const files = new Map<string, string>();
    const { runner, calls } = fakeRunner({
      stdout: [
        JSON.stringify({ type: "thread.started" }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 },
        }),
      ].join("\n"),
    });
    const agent = createCodingAgent(resolveCodingBackend({ defaultBackend: "codex" }), {
      runner,
      env: { LITELLM_MASTER_KEY: LITELLM_KEY, PATH: "/usr/bin" },
      codexHome: "/tmp/optio-codex-home",
      writeTextFile: async (filePath, contents) => {
        files.set(filePath, contents);
      },
    });

    const output = await agent.run(sampleInput());

    expect(agent.id).toBe("codex");
    expect(output.status).toBe("succeeded");
    expect(output.pr_ready).toBe(false);
    expect(output.usage).toEqual({
      provider: "codex",
      model_id: "gpt-4o",
      input_tokens: 100,
      output_tokens: 7,
      cached_tokens: 40,
    });

    const configPath = "/tmp/optio-codex-home/config.toml";
    const config = files.get(configPath);
    expect(config).toBeDefined();
    expect(configPath.startsWith("/tmp/wt-task")).toBe(false);
    expect(config).toContain(`openai_base_url = "${LITELLM_URL}"`);
    expect(config).toContain('model_provider = "harness_gateway"');
    expect(config).toContain("[model_providers.harness_gateway]");
    expect(config).toContain(`base_url = "${LITELLM_URL}"`);
    expect(config).toContain('env_key = "LITELLM_MASTER_KEY"');
    expect(config).toContain('wire_api = "responses"');
    expect(config).toContain('model = "gpt-4o"');
    expect(config).not.toContain(LITELLM_KEY);

    const call = calls[0];
    expect(call?.command).toBe("codex");
    expect(call?.args.slice(0, 3)).toEqual(["exec", "--json", "--skip-git-repo-check"]);
    expect(call?.args).toContain("workspace-write");
    expect(call?.args).toContain("-m");
    expect(call?.args.at(-1)).toBe(EXPECTED_PROMPT);
    expect(call?.args.join(" ")).not.toContain(LITELLM_KEY);
    expect(call?.cwd).toBe("/tmp/wt-task");
    expect(call?.env.CODEX_HOME).toBe("/tmp/optio-codex-home");
    expect(call?.env.OPENAI_BASE_URL).toBe(LITELLM_URL);
    expect(call?.env.LITELLM_MASTER_KEY).toBe(LITELLM_KEY);
    expect(call?.env.CURSOR_API_KEY).toBeUndefined();
  });

  it("points openai_base_url at the Caveman LiteLLM compat mount when enabled", async () => {
    const files = new Map<string, string>();
    const { runner, calls } = fakeRunner({
      stdout: JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });
    const agent = createCodingAgent("codex", {
      runner,
      env: {
        CAVEMAN_PROXY_ENABLED: "true",
        LITELLM_MASTER_KEY: LITELLM_KEY,
      },
      codexHome: "/tmp/optio-codex-caveman",
      writeTextFile: async (filePath, contents) => {
        files.set(filePath, contents);
      },
    });

    const output = await agent.run(sampleInput());
    expect(output.status).toBe("succeeded");
    const config = files.get("/tmp/optio-codex-caveman/config.toml");
    expect(config).toContain(`openai_base_url = "${CAVEMAN_URL}"`);
    expect(config).toContain(`base_url = "${CAVEMAN_URL}"`);
    expect(calls[0]?.env.OPENAI_BASE_URL).toBe(CAVEMAN_URL);
    expect(config).not.toContain(LITELLM_KEY);
  });

  it("maps a gateway budget error to budget_exhausted and redacts the virtual key", async () => {
    const files = new Map<string, string>();
    const { runner } = fakeRunner({
      exitCode: 1,
      stderr: `budget exceeded for key ${LITELLM_KEY}`,
    });
    const agent = createCodingAgent("codex", {
      runner,
      env: { LITELLM_MASTER_KEY: LITELLM_KEY },
      codexHome: "/tmp/optio-codex-budget",
      writeTextFile: async (filePath, contents) => {
        files.set(filePath, contents);
      },
    });
    const output = await agent.run(sampleInput());
    expect(output.status).toBe("budget_exhausted");
    expect(output.error_class).toBe("budget_exhausted");
    expect(output.usage.provider).toBe("codex");
    expect(output.logs).toContain("budget exceeded");
    expect(output.logs).not.toContain(LITELLM_KEY);
    expect(output.logs).toContain("[redacted]");
  });

  it("uses a read-only sandbox when the step cannot edit", async () => {
    const { runner, calls } = fakeRunner({
      stdout: JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });
    const agent = createCodingAgent("codex", {
      runner,
      env: { LITELLM_MASTER_KEY: LITELLM_KEY },
      codexHome: "/tmp/optio-codex-ro",
      writeTextFile: async () => {},
    });
    await agent.run(sampleInput({ allowed_tools: ["read"] }));
    expect(calls[0]?.args).toContain("read-only");
    expect(calls[0]?.args).not.toContain("workspace-write");
  });

  it("does not spawn when LITELLM_MASTER_KEY is missing", async () => {
    const { runner, calls } = fakeRunner({});
    const agent = createCodingAgent("codex", { runner, env: {} });
    const output = await agent.run(sampleInput());
    expect(output.status).toBe("failed");
    expect(output.error_class).toBe("missing_credentials");
    expect(calls).toHaveLength(0);
  });
});

describe("flip coding_backend", () => {
  it("keeps the task prompt and adds Cursor implement feedback only on Cursor", async () => {
    const cursorRun = fakeRunner({
      stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    });
    const codexRun = fakeRunner({
      stdout: JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 2, output_tokens: 3 },
      }),
    });
    const input = sampleInput();
    const cursor = createCodingAgent(resolveCodingBackend({ stepCodingBackend: "cursor" }), {
      runner: cursorRun.runner,
      env: { CURSOR_API_KEY: CURSOR_KEY },
    });
    const codex = createCodingAgent(resolveCodingBackend({ stepCodingBackend: "codex" }), {
      runner: codexRun.runner,
      env: { LITELLM_MASTER_KEY: LITELLM_KEY },
      codexHome: "/tmp/optio-codex-flip",
      writeTextFile: async () => {},
    });

    const cursorOutput = await cursor.run(input);
    const codexOutput = await codex.run(input);

    expect(cursorOutput.status).toBe("succeeded");
    expect(codexOutput.status).toBe("succeeded");
    expect(cursorRun.calls[0]?.args.at(-1)).toBe(CURSOR_IMPLEMENT_PROMPT);
    expect(codexRun.calls[0]?.args.at(-1)).toBe(EXPECTED_PROMPT);
    expect(cursorRun.calls[0]?.command).toBe("agent");
    expect(codexRun.calls[0]?.command).toBe("codex");
    expect(cursorOutput.usage.provider).toBe("cursor");
    expect(codexOutput.usage).toMatchObject({
      provider: "codex",
      input_tokens: 2,
      output_tokens: 3,
    });
  });
});

describe("spawnCli", () => {
  it("captures stdout from a local process", async () => {
    const result = await spawnCli({
      command: process.execPath,
      args: ["-e", "process.stdout.write('ok')"],
      cwd: process.cwd(),
      env: process.env,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
    expect(result.timedOut).toBe(false);
  });

  it("reports a missing binary as exit 127", async () => {
    const result = await spawnCli({
      command: "optio-missing-cli-binary",
      args: [],
      cwd: process.cwd(),
      env: process.env,
    });
    expect(result.exitCode).toBe(127);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it("marks a wall-clock kill as timed out", async () => {
    const result = await spawnCli({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 30000)"],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 200,
    });
    expect(result.timedOut).toBe(true);
  }, 5000);
});
