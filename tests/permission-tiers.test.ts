import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import type { CodingAgentInput } from "../src/adapters/coding-agent.js";
import { createCodingAgent } from "../src/adapters/select.js";
import type { CliRunRequest, CliRunResult } from "../src/adapters/runtime.js";
import { WORKFLOW_STAGE_PERMISSION, type PermissionTier } from "../src/kit-harness/permissions.js";
import { decideTool, invokeGuardedTool } from "../src/kit-harness/index.js";
import { createKitHarnessServer } from "../src/kit-harness/server.js";

const TIERS: PermissionTier[] = ["read-only", "edit-worktree", "git-push", "host-admin"];

function input(overrides: Partial<CodingAgentInput> = {}): CodingAgentInput {
  return {
    worktree_path: "/tmp/wt-task",
    prompt: "implement the seam",
    instructions: "follow the spec",
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

function fakeRunner() {
  const calls: CliRunRequest[] = [];
  return {
    calls,
    runner: async (request: CliRunRequest): Promise<CliRunResult> => {
      calls.push(request);
      return {
        exitCode: 0,
        stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false }),
        stderr: "",
        timedOut: false,
        signal: null,
      };
    },
  };
}

describe("permission tier matrix", () => {
  const cases: Array<{
    name: string;
    tool: string;
    context: {
      command?: string;
      path?: string;
      permission_tier?: PermissionTier;
      step_id?: string;
    };
    decision: "allow" | "confirm" | "deny";
    reason?: string;
    observation?: RegExp;
  }> = [
    {
      name: "read-only allows a worktree read",
      tool: "read_file",
      context: { path: "src/app.ts", permission_tier: "read-only" },
      decision: "allow",
    },
    {
      name: "read-only allows git status",
      tool: "shell",
      context: { command: "git status", permission_tier: "read-only" },
      decision: "allow",
      reason: "read_only_command",
    },
    {
      name: "read-only denies a worktree edit",
      tool: "write_file",
      context: { path: "src/app.ts", permission_tier: "read-only" },
      decision: "deny",
      reason: "permission_denied",
      observation: /Editing the worktree was not executed.*Required tier: edit-worktree/,
    },
    {
      name: "edit-worktree allows a worktree edit",
      tool: "write_file",
      context: { path: "src/app.ts", permission_tier: "edit-worktree" },
      decision: "allow",
    },
    {
      name: "edit-worktree allows npm test",
      tool: "shell",
      context: { command: "npm test", permission_tier: "edit-worktree" },
      decision: "allow",
      reason: "safe_command",
    },
    {
      name: "edit-worktree denies git push",
      tool: "git_push",
      context: { command: "git push origin feature/kit", permission_tier: "edit-worktree" },
      decision: "deny",
      reason: "permission_denied",
      observation: /git push was not executed.*Required tier: git-push/,
    },
    {
      name: "git-push confirms a feature-branch push",
      tool: "git_push",
      context: { command: "git push origin feature/kit", permission_tier: "git-push" },
      decision: "confirm",
      reason: "confirm_tool",
    },
    {
      name: "git-push denies docker.sock",
      tool: "shell",
      context: { command: "cat /var/run/docker.sock", permission_tier: "git-push" },
      decision: "deny",
      reason: "permission_denied",
      observation: /docker\.sock was not executed.*Required tier: host-admin/,
    },
    {
      name: "git-push denies /root",
      tool: "read_file",
      context: { path: "/root/.config/sops/age/keys.txt", permission_tier: "git-push" },
      decision: "deny",
      reason: "permission_denied",
      observation: /\/root was not executed.*host-admin/,
    },
    {
      name: "edit-worktree denies sops decrypt",
      tool: "shell",
      context: { command: "sops -d secrets/optio-new.env", permission_tier: "edit-worktree" },
      decision: "deny",
      reason: "permission_denied",
      observation: /sops keys was not executed.*Required tier: host-admin/,
    },
    {
      name: "read-only denies a sops key file",
      tool: "read_file",
      context: { path: "secrets/.sops.yaml", permission_tier: "read-only" },
      decision: "deny",
      reason: "permission_denied",
      observation: /sops keys was not executed/,
    },
    {
      name: "host-admin allows docker.sock",
      tool: "shell",
      context: { command: "cat /var/run/docker.sock", permission_tier: "host-admin" },
      decision: "allow",
    },
    {
      name: "host-admin allows /root",
      tool: "read_file",
      context: { path: "/root/.config/sops/age/keys.txt", permission_tier: "host-admin" },
      decision: "allow",
    },
    {
      name: "host-admin confirms sops decrypt",
      tool: "shell",
      context: { command: "sops -d secrets/optio-new.env", permission_tier: "host-admin" },
      decision: "confirm",
    },
    {
      name: "host-admin allows the sops rules file",
      tool: "read_file",
      context: { path: "secrets/.sops.yaml", permission_tier: "host-admin" },
      decision: "allow",
    },
    {
      name: "host-admin still denies .env",
      tool: "read_file",
      context: { path: ".env", permission_tier: "host-admin" },
      decision: "deny",
      reason: "hard_deny_secret",
    },
    {
      name: "host-admin still denies rm -rf",
      tool: "shell",
      context: { command: "rm -rf /tmp/optio-agent", permission_tier: "host-admin" },
      decision: "deny",
      reason: "hard_deny_destructive",
    },
    {
      name: "host-admin still denies a protected-branch push",
      tool: "shell",
      context: { command: "git push origin main", permission_tier: "host-admin" },
      decision: "deny",
      reason: "hard_deny_destructive",
    },
    {
      name: "implementation default allows an edit",
      tool: "write_file",
      context: { path: "src/app.ts", step_id: "implementation" },
      decision: "allow",
    },
    {
      name: "review default denies an edit",
      tool: "write_file",
      context: { path: "src/app.ts", step_id: "review" },
      decision: "deny",
      reason: "permission_denied",
      observation: /Permission denied \(read-only\)/,
    },
    {
      name: "unknown step defaults to read-only",
      tool: "write_file",
      context: { path: "src/app.ts", step_id: "record_diff" },
      decision: "deny",
      reason: "permission_denied",
    },
  ];

  it.each(cases)("$name", async (entry) => {
    const decision = await decideTool(entry.tool, entry.context);
    expect(decision.decision).toBe(entry.decision);
    if (entry.reason) expect(decision.reason).toBe(entry.reason);
    if (entry.observation) {
      expect(decision.observation).toMatch(entry.observation);
      expect(decision.observation).toMatch(/was not executed/);
      expect(decision.hard).toBe(true);
    }
    if (entry.decision !== "deny") expect(decision.observation).toBeUndefined();
  });

  it("returns the observation from a guarded tool call", async () => {
    let ran = false;
    const result = await invokeGuardedTool({
      tool: "shell",
      context: { command: "cat /var/run/docker.sock", permission_tier: "edit-worktree" },
      timeout_ms: 50,
      run: async () => {
        ran = true;
        return { ok: true };
      },
    });
    expect(ran).toBe(false);
    expect(result.status).toBe("deny");
    expect(result.reason).toBe("permission_denied");
    expect(result.observation).toMatch(/docker\.sock was not executed/);
    expect(result.observation).toMatch(/Required tier: host-admin/);
  });

  it("accepts permission_tier on the tool-gate HTTP body", async () => {
    const server: Server = createKitHarnessServer({ env: {} });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a TCP port");
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/tool-gate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tool: "shell",
          context: { command: "git push origin feature/kit", permission_tier: "read-only" },
        }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { decision: string; observation?: string };
      expect(body.decision).toBe("deny");
      expect(body.observation).toMatch(/git push was not executed/);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("keeps host-admin off every workflow stage default", () => {
    for (const tier of Object.values(WORKFLOW_STAGE_PERMISSION)) {
      expect(tier).not.toBe("host-admin");
      expect(TIERS).toContain(tier);
    }
    expect(WORKFLOW_STAGE_PERMISSION).toEqual({
      planner: "read-only",
      implementation: "edit-worktree",
      review: "read-only",
      ready: "git-push",
      merge: "git-push",
    });
  });

  it("matches workflows/default-task.yaml", async () => {
    const raw = await readFile("workflows/default-task.yaml", "utf8");
    const workflow = parse(raw) as { steps: { id: string; permission_tier: string }[] };
    const fromYaml = Object.fromEntries(
      workflow.steps.map((step) => [step.id, step.permission_tier]),
    );
    expect(fromYaml).toEqual(WORKFLOW_STAGE_PERMISSION);
  });
});

describe("CodingAgent permission gate", () => {
  it("does not spawn when allowed tools exceed the stage tier", async () => {
    const cursor = fakeRunner();
    const codexWrites: string[] = [];
    const codex = fakeRunner();
    const cursorAgent = createCodingAgent("cursor", {
      runner: cursor.runner,
      env: { CURSOR_API_KEY: "cursor-key" },
    });
    const codexAgent = createCodingAgent("codex", {
      runner: codex.runner,
      env: { LITELLM_MASTER_KEY: "virtual-key" },
      codexHome: "/tmp/optio-codex-tier",
      writeTextFile: async (filePath) => {
        codexWrites.push(filePath);
      },
    });
    const request = input({
      allowed_tools: ["git_push"],
      metadata: {
        task_id: "t-9",
        worktree_id: "wt-9",
        workflow_id: "default-task",
        step_id: "invoke_implementation",
        agent_id: "agents/implementation",
      },
    });

    const cursorOutput = await cursorAgent.run(request);
    const codexOutput = await codexAgent.run(request);

    expect(cursor.calls).toHaveLength(0);
    expect(codex.calls).toHaveLength(0);
    expect(codexWrites).toHaveLength(0);
    expect(cursorOutput).toMatchObject({
      status: "failed",
      error_class: "permission_denied",
    });
    expect(cursorOutput.observation).toMatch(/allowed_tools \[git_push\] was not executed/);
    expect(cursorOutput.observation).toMatch(/Permission denied \(edit-worktree\)/);
    expect(cursorOutput.observation).toMatch(/Required tier: git-push/);
    expect(cursorOutput.logs).toBe(cursorOutput.observation);
    expect(codexOutput.observation).toBe(cursorOutput.observation);
  });

  it("sandboxes an implementation edit and opens the host only for host-admin", async () => {
    const edit = fakeRunner();
    const host = fakeRunner();
    const env = { CURSOR_API_KEY: "cursor-key" };
    const editAgent = createCodingAgent("cursor", { runner: edit.runner, env });
    const hostAgent = createCodingAgent("cursor", { runner: host.runner, env });

    await editAgent.run(input());
    await hostAgent.run(
      input({
        allowed_tools: ["docker"],
        permission_tier: "host-admin",
      }),
    );

    expect(edit.calls[0]?.args).toEqual(
      expect.arrayContaining(["--sandbox", "enabled", "--force"]),
    );
    expect(host.calls[0]?.args).toContain("--force");
    expect(host.calls[0]?.args).not.toContain("--sandbox");
  });

  it("uses Codex danger-full-access only when the tier is host-admin", async () => {
    const files = new Map<string, string>();
    const host = fakeRunner();
    const agent = createCodingAgent("codex", {
      runner: host.runner,
      env: { LITELLM_MASTER_KEY: "virtual-key" },
      codexHome: "/tmp/optio-codex-host",
      writeTextFile: async (filePath, contents) => {
        files.set(filePath, contents);
      },
    });
    const output = await agent.run(
      input({
        allowed_tools: ["sops"],
        permission_tier: "host-admin",
      }),
    );
    expect(output.status).toBe("succeeded");
    expect(host.calls[0]?.args).toContain("danger-full-access");
    expect(files.get("/tmp/optio-codex-host/config.toml")).toContain(
      'sandbox_mode = "danger-full-access"',
    );
  });
});
