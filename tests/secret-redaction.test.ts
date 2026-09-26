import { afterEach, describe, expect, it, vi } from "vitest";
import { ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { CodingAgentInput } from "../src/adapters/coding-agent.js";
import { createCursorAdapter } from "../src/adapters/cursor/index.js";
import { clearToolAudit, decideTool, readToolAudit } from "../src/kit-harness/index.js";
import { redactExcerpt } from "../src/orchestrator/learning/observation.js";
import { logStageEvent } from "../src/orchestrator/jobs/stage-log.js";
import { InMemoryStepCursorStore, createStageTracer, processStageJob } from "../src/index.js";
import {
  SECRET_ENV_NAMES,
  formatAgentDump,
  formatStageLog,
  redactSecrets,
} from "../src/security/redact.js";

const CURSOR = "cursor-plain-value-991122";
const GITHUB = `ghp_${"OptioTestTokenValue1234567890abcd"}`;
const MODEL = `sk-${"optioModelKeyValue1234567890abcd"}`;
const PAT = `github_pat_${"11AAAAA_abcdefghijklmnopqrstuvwxyz012345"}`;
const CURSOR_KEY = `crsr_${"optioCursorKeyValue1234567890abcd"}`;
const ANTHROPIC = `sk-${"ant-api03-optioAnthropicKeyValue1234567890"}`;
const GITLAB = `glpat-${"optioGitlabKeyValue1234567890"}`;
const SLACK = `xox${"b"}-123456789012-abcdefghijklmnopqrstuv`;
const AWS = `AKI${"A"}OPTIOTESTKEY1234`;
const GOOGLE = `AIza${"OptioTestGoogleKeyValue1234567890"}`;
const ENTROPY = "Qx7mNp2vLr9sKd4wYb8cTf1hAg6eZu3nHj5oPq8W";
const UUID = "123e4567-e89b-12d3-a456-426614174000";
const SHA256 = "ab".repeat(32);
const PEM_BODY = "MIIBfakeoptiotest";

const KNOWN_SECRETS = [
  CURSOR,
  GITHUB,
  MODEL,
  PAT,
  CURSOR_KEY,
  ANTHROPIC,
  GITLAB,
  SLACK,
  AWS,
  GOOGLE,
  ENTROPY,
  "secretpass",
  PEM_BODY,
];

function assertSecretsAbsent(formatted: string): void {
  for (const secret of KNOWN_SECRETS) {
    expect(formatted).not.toContain(secret);
  }
}

afterEach(() => {
  clearToolAudit();
  vi.restoreAllMocks();
});

describe("secret redaction", () => {
  it("keeps known secret strings out of formatted stage logs", () => {
    const assignments = SECRET_ENV_NAMES.map((name) => `${name}=value-for-${name}-Zz9`);
    const formatted = formatStageLog({
      msg: "stage step",
      taskId: "t-1",
      worktreeId: UUID,
      fingerprint: SHA256,
      error: [
        ...assignments,
        `CURSOR_API_KEY=${CURSOR}`,
        `OPTIO_NEW_GITHUB_TOKEN=${GITHUB}`,
        `MODEL_API_KEY=${MODEL}`,
        `Authorization: Bearer ${ANTHROPIC}`,
        PAT,
        CURSOR_KEY,
        GITLAB,
        SLACK,
        AWS,
        GOOGLE,
        `argv ${ENTROPY}`,
        "postgres://optio:secretpass@postgres:5432/db",
        `-----BEGIN PRIVATE KEY-----\n${PEM_BODY}\n-----END PRIVATE KEY-----`,
      ].join(" "),
    });

    assertSecretsAbsent(formatted);
    for (const name of ["CURSOR_API_KEY", "OPTIO_NEW_GITHUB_TOKEN", "MODEL_API_KEY"]) {
      expect(formatted).toContain(name);
    }
    for (const name of SECRET_ENV_NAMES) {
      expect(formatted).not.toContain(`value-for-${name}-Zz9`);
    }
    expect(formatted).toContain("[redacted]");
    expect(formatted).toContain("stage step");
    expect(formatted).toContain("t-1");
    expect(formatted).toContain(UUID);
    expect(formatted).toContain(SHA256);
    expect(formatted).toContain("postgres://optio:[redacted]@postgres:5432/db");
  });

  it("writes stage log lines through the same formatter", () => {
    const lines: string[] = [];
    logStageEvent(
      { msg: "worker error", queue: "optio.plan", error: `CURSOR_API_KEY=${CURSOR}` },
      (line) => lines.push(line),
    );
    expect(lines).toHaveLength(1);
    assertSecretsAbsent(lines[0] ?? "");
    expect(lines[0]).toContain("worker error");
    expect(lines[0]).toContain("[redacted]");
  });

  it("redacts span attributes, status, and exception events before export", async () => {
    const exported: ReadableSpan[] = [];
    const exporter: SpanExporter = {
      export(spans, resultCallback) {
        exported.push(...spans);
        resultCallback({ code: ExportResultCode.SUCCESS });
      },
      shutdown() {
        return Promise.resolve();
      },
    };
    const tracer = createStageTracer({
      targets: [{ name: "signoz", endpoint: "http://127.0.0.1:9/v1/traces" }],
      createExporter: () => exporter,
    });

    await tracer.runStage(
      "workflow.step",
      {
        taskId: "t-1",
        worktreeId: "wt-1",
        attributes: { note: `CURSOR_API_KEY=${CURSOR} ${GITHUB}` },
      },
      (span) => {
        span.setAttribute("tool_output", `${MODEL} ${PAT}`);
        span.fail(`OPTIO_NEW_GITHUB_TOKEN=${GITHUB}`);
      },
    );

    let caught: unknown;
    try {
      await tracer.runStage("agent.run", { taskId: "t-1", worktreeId: UUID }, () => {
        throw new Error(`MODEL_API_KEY=${MODEL} ${ENTROPY}`);
      });
    } catch (error) {
      caught = error;
    }

    const formatted = [
      JSON.stringify(tracer.finished()),
      JSON.stringify(
        exported.map((span) => ({
          attributes: span.attributes,
          status: span.status,
          events: span.events,
        })),
      ),
      caught instanceof Error ? `${caught.message}\n${caught.stack ?? ""}` : String(caught),
    ].join("\n");

    assertSecretsAbsent(formatted);
    expect(formatted).toContain("[redacted]");
    expect(formatted).toContain("t-1");
    expect(formatted).toContain(UUID);
    expect(caught).toBeInstanceOf(Error);
    await tracer.shutdown();
  });

  it("redacts secrets thrown from a stage handler", async () => {
    const tracer = createStageTracer();
    let caught: unknown;
    try {
      await processStageJob(
        { taskId: "t-1", sessionId: "s-1", stage: "plan" },
        {
          cursors: new InMemoryStepCursorStore(),
          tracer,
          handler: {
            async run() {
              throw new Error(`stage failed CURSOR_API_KEY=${CURSOR} ${GITHUB}`);
            },
          },
        },
      );
    } catch (error) {
      caught = error;
    }
    const formatted = `${JSON.stringify(tracer.finished())}\n${
      caught instanceof Error ? caught.message : String(caught)
    }`;
    assertSecretsAbsent(formatted);
    expect(formatted).toContain("[redacted]");
    await tracer.shutdown();
  });

  it("redacts adapter stderr and stored learning excerpts", async () => {
    const adapter = createCursorAdapter({
      env: { CURSOR_API_KEY: CURSOR },
      runner: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: `tool dump CURSOR_API_KEY=${CURSOR} ${GITHUB} ${MODEL}`,
        timedOut: false,
        signal: null,
      }),
    });
    const input: CodingAgentInput = {
      worktree_path: "/tmp/wt-task",
      prompt: "implement",
      allowed_tools: ["edit"],
      budget: {},
      metadata: {
        task_id: "t-9",
        worktree_id: "wt-9",
        workflow_id: "default-task",
        step_id: "implementation",
        agent_id: "agents/implementation",
      },
    };
    const output = await adapter.run(input);
    const excerpt = redactExcerpt(
      `postgres://optio:secretpass@db/optio Bearer ${ANTHROPIC} ${PAT}`,
    );
    const dump = formatAgentDump({
      logs: output.logs,
      excerpt,
      command: `MODEL_API_KEY=${MODEL}`,
    });
    assertSecretsAbsent(`${output.logs ?? ""}\n${excerpt}\n${dump}`);
    expect(dump).toContain("[redacted]");
    expect(output.logs).toContain("tool dump");
  });

  it("redacts kit-harness deny audit lines and stored commands", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
      lines.push(String(line));
    });
    await decideTool("printenv", {
      command: `CURSOR_API_KEY=${CURSOR} ${GITHUB}`,
      agent_id: "scenario-agent",
    });
    const formatted = `${lines.join("\n")}\n${JSON.stringify(readToolAudit())}`;
    assertSecretsAbsent(formatted);
    expect(formatted).toContain("[redacted]");
    expect(formatted).toContain("printenv");
  });

  it("leaves ordinary stage text unchanged", () => {
    const plain = "stage plan step invoke_planner task=t-1";
    expect(redactSecrets(plain)).toBe(plain);
  });
});
