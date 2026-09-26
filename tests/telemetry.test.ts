import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CodingAgentInput } from "../src/adapters/coding-agent.js";
import {
  CANONICAL_SPAN,
  InMemoryStepCursorStore,
  StageNotReadyError,
  createAgentStageHandler,
  createCodexAdapter,
  createCursorAdapter,
  createStageTracer,
  enqueueIntakePipeline,
  loadTelemetryExportConfig,
  processStageJob,
  resolveExporterTargets,
  runAgentLoop,
  runPipeline,
  type ModelAdapter,
  type SkillLoader,
  type StageStepHandler,
} from "../src/index.js";

const identity = { taskId: "t-1", sessionId: "s-1" };

const specSpanNames = [
  "workflow.step",
  "agent.run",
  "specialist.call",
  "skill.load",
  "jev.decision",
  "worktree.create",
  "worktree.remove",
  "intake.webhook",
  "gate.pass",
  "gate.fail",
  "session.queue",
];

function noopHandler(): StageStepHandler {
  return { async run() {} };
}

function adapterInput(taskId: string, worktreeId: string): CodingAgentInput {
  return {
    worktree_path: "/tmp/wt",
    prompt: "implement",
    allowed_tools: [],
    budget: {},
    metadata: {
      task_id: taskId,
      worktree_id: worktreeId,
      workflow_id: "default-task",
      step_id: "implement",
      agent_id: "codex",
    },
  };
}

describe("orchestrator OpenTelemetry spans", () => {
  it("names the canonical spans from SPEC §12.4", () => {
    expect([...Object.values(CANONICAL_SPAN)].sort()).toEqual([...specSpanNames].sort());
  });

  it("tags each pipeline stage with task_id and worktree_id", async () => {
    const tracer = createStageTracer();
    const result = await runPipeline(identity, {
      cursors: new InMemoryStepCursorStore(),
      handler: noopHandler(),
      tracer,
      worktreeId: "wt-1",
    });

    expect(result.stages.map((stage) => stage.stage)).toEqual([
      "plan",
      "implement",
      "review",
      "ready",
      "merge",
    ]);
    const steps = tracer.finished().filter((span) => span.name === "workflow.step");
    expect(steps.map((span) => span.attributes.step_id)).toEqual([
      "plan",
      "implement",
      "review",
      "ready",
      "merge",
    ]);
    for (const span of steps) {
      expect(span.status).toBe("ok");
      expect(span.attributes.task_id).toBe("t-1");
      expect(span.attributes.worktree_id).toBe("wt-1");
      expect(span.attributes.workflow_id).toBe("default-task");
    }
    await tracer.shutdown();
  });

  it("records an empty worktree_id when no worktree exists yet", async () => {
    const tracer = createStageTracer();
    await processStageJob(
      { ...identity, stage: "plan" },
      { cursors: new InMemoryStepCursorStore(), handler: noopHandler(), tracer },
    );
    const [span] = tracer.finished();
    expect(span?.attributes.worktree_id).toBe("");
    expect(span?.attributes.task_id).toBe("t-1");
    await tracer.shutdown();
  });

  it("marks the stage span failed when the stage throws", async () => {
    const tracer = createStageTracer();
    await expect(
      processStageJob(
        { ...identity, stage: "implement" },
        { cursors: new InMemoryStepCursorStore(), handler: noopHandler(), tracer },
      ),
    ).rejects.toBeInstanceOf(StageNotReadyError);

    expect(tracer.finished()).toEqual([
      expect.objectContaining({
        name: "workflow.step",
        status: "error",
        attributes: expect.objectContaining({
          task_id: "t-1",
          worktree_id: "",
          step_id: "implement",
          error_class: "StageNotReadyError",
        }),
      }),
    ]);
    await tracer.shutdown();
  });

  it("nests agent.run and skill.load under the stage span", async () => {
    const tracer = createStageTracer();
    await processStageJob(
      { ...identity, stage: "plan" },
      {
        cursors: new InMemoryStepCursorStore(),
        handler: createAgentStageHandler({
          async complete() {
            return { text: "ok" };
          },
        }),
        tracer,
        worktreeId: "wt-2",
      },
    );

    const spans = tracer.finished();
    const stage = spans.find((span) => span.name === "workflow.step");
    const agents = spans.filter((span) => span.name === "agent.run");
    const skills = spans.filter((span) => span.name === "skill.load");
    expect(stage?.attributes).toMatchObject({
      task_id: "t-1",
      worktree_id: "wt-2",
      step_id: "plan",
    });
    expect(agents).toHaveLength(2);
    for (const agent of agents) {
      expect(agent.parentSpanId).toBe(stage?.spanId);
      expect(agent.traceId).toBe(stage?.traceId);
      expect(agent.attributes.task_id).toBe("t-1");
      expect(agent.attributes.worktree_id).toBe("wt-2");
    }
    expect(skills.length).toBeGreaterThan(0);
    for (const skill of skills) {
      expect(agents.map((agent) => agent.spanId)).toContain(skill.parentSpanId);
      expect(skill.attributes.task_id).toBe("t-1");
      expect(skill.attributes.worktree_id).toBe("wt-2");
      expect(skill.attributes.skill_id).toBeTruthy();
    }
    await tracer.shutdown();
  });

  it("emits intake.webhook around enqueue", async () => {
    const tracer = createStageTracer();
    const enqueued = await enqueueIntakePipeline(
      { taskId: "t-9", title: "Ship graph", description: "issue 13" },
      {
        async add() {
          return { id: "flow-1" };
        },
      },
      undefined,
      tracer,
    );
    expect(enqueued.taskId).toBe("t-9");
    expect(tracer.finished()).toEqual([
      expect.objectContaining({
        name: "intake.webhook",
        status: "ok",
        attributes: expect.objectContaining({
          task_id: "t-9",
          worktree_id: "",
          session_id: "t-9",
        }),
      }),
    ]);

    const failed = createStageTracer();
    await expect(
      enqueueIntakePipeline({ taskId: "", title: "x" }, { async add() {} }, undefined, failed),
    ).rejects.toThrow();
    expect(failed.finished()[0]).toMatchObject({
      name: "intake.webhook",
      status: "error",
      attributes: { task_id: "", worktree_id: "" },
    });
    await tracer.shutdown();
    await failed.shutdown();
  });

  it("emits gate.fail and gate.pass with task_id from the agent loop", async () => {
    const tracer = createStageTracer();
    const denied = await runAgentLoop(
      {
        prompt: "read env",
        taskId: "t-gate",
        tracer,
        tools: {
          audit: { record() {} },
          execute: async () => "secret-bytes",
          taskId: "t-gate",
          stepId: "implementation",
          worktreeRoot: "/tmp/wt",
        },
      },
      {
        async complete(): Promise<Awaited<ReturnType<ModelAdapter["complete"]>>> {
          return { text: "ack", toolCalls: [{ tool: "read_file", action: "read", path: ".env" }] };
        },
      },
      {
        async resolve() {
          return [];
        },
      } satisfies SkillLoader,
    );
    expect(denied.toolResults?.[0]?.status).toBe("denied");
    expect(tracer.finished()).toEqual([
      expect.objectContaining({
        name: "gate.fail",
        status: "error",
        attributes: expect.objectContaining({
          task_id: "t-gate",
          worktree_id: "",
          gate_id: "secrets",
          step_id: "implementation",
          error_class: "secrets",
        }),
      }),
    ]);

    const allowedTracer = createStageTracer();
    const allowed = await runAgentLoop(
      {
        prompt: "read example",
        taskId: "t-allow",
        tracer: allowedTracer,
        tools: {
          audit: { record() {} },
          execute: async () => "example",
          taskId: "t-allow",
          worktreeRoot: "/tmp/wt",
        },
      },
      {
        async complete() {
          return {
            text: "ack",
            toolCalls: [{ tool: "read_file", action: "read" as const, path: ".env.example" }],
          };
        },
      },
      {
        async resolve() {
          return [];
        },
      },
    );
    expect(allowed.toolResults?.[0]?.status).toBe("allowed");
    expect(allowedTracer.finished()[0]).toMatchObject({
      name: "gate.pass",
      status: "ok",
      attributes: expect.objectContaining({
        task_id: "t-allow",
        worktree_id: "",
        gate_id: "none",
      }),
    });
    await tracer.shutdown();
    await allowedTracer.shutdown();
  });

  it("emits agent.run around coding-agent runs that fail closed without credentials", async () => {
    const tracer = createStageTracer();
    const codex = createCodexAdapter({ env: {}, tracer });
    const cursor = createCursorAdapter({ env: {}, tracer });
    const codexOut = await codex.run(adapterInput("adapter-codex-1", "wt-codex"));
    const cursorOut = await cursor.run(adapterInput("adapter-cursor-1", "wt-cursor"));

    expect(codexOut).toMatchObject({ status: "failed", error_class: "missing_credentials" });
    expect(cursorOut).toMatchObject({ status: "failed", error_class: "missing_credentials" });
    expect(
      tracer.finished().find((span) => span.attributes.task_id === "adapter-codex-1"),
    ).toMatchObject({
      name: "agent.run",
      status: "error",
      attributes: expect.objectContaining({
        task_id: "adapter-codex-1",
        worktree_id: "wt-codex",
        agent_id: "codex",
        step_id: "implement",
        error_class: "missing_credentials",
      }),
    });
    expect(
      tracer.finished().find((span) => span.attributes.task_id === "adapter-cursor-1"),
    ).toMatchObject({
      name: "agent.run",
      status: "error",
      attributes: expect.objectContaining({
        task_id: "adapter-cursor-1",
        worktree_id: "wt-cursor",
        agent_id: "cursor",
        error_class: "missing_credentials",
      }),
    });
    await tracer.shutdown();
  });
});

describe("Langfuse and SigNoz exporters", () => {
  it("keeps both exporters off unless the flag is the string true", () => {
    expect(resolveExporterTargets(loadTelemetryExportConfig({}))).toEqual([]);
    expect(
      resolveExporterTargets(
        loadTelemetryExportConfig({
          OPTIO_OTEL_LANGFUSE: "false",
          OPTIO_OTEL_SIGNOZ: "1",
        }),
      ),
    ).toEqual([]);
    expect(loadTelemetryExportConfig({ OPTIO_OTEL_LANGFUSE: "TRUE" }).langfuse).toBe(true);
    expect(loadTelemetryExportConfig({ OPTIO_OTEL_SIGNOZ: "true" }).signoz).toBe(true);
  });

  it("builds a Langfuse OTLP target with Basic auth and a SigNoz collector target", () => {
    const targets = resolveExporterTargets(
      loadTelemetryExportConfig({
        OPTIO_OTEL_LANGFUSE: "true",
        OPTIO_OTEL_SIGNOZ: "true",
        LANGFUSE_HOST: "http://langfuse.internal/",
        LANGFUSE_PUBLIC_KEY: "pk-test",
        LANGFUSE_SECRET_KEY: "sk-test",
        OPTIO_SIGNOZ_OTLP_ENDPOINT: "http://otel-collector:4318/v1/traces",
      }),
    );
    expect(targets).toEqual([
      {
        name: "langfuse",
        endpoint: "http://langfuse.internal/api/public/otel/v1/traces",
        headers: {
          Authorization: `Basic ${Buffer.from("pk-test:sk-test").toString("base64")}`,
        },
      },
      { name: "signoz", endpoint: "http://otel-collector:4318/v1/traces" },
    ]);
  });

  it("does not attach an Authorization header when Langfuse keys are missing", () => {
    const [target] = resolveExporterTargets(
      loadTelemetryExportConfig({ OPTIO_OTEL_LANGFUSE: "true" }),
    );
    expect(target).toEqual({
      name: "langfuse",
      endpoint: "http://127.0.0.1:3000/api/public/otel/v1/traces",
    });
  });

  it("forwards finished spans to configured exporters and to none by default", async () => {
    const idleFactory = () => {
      throw new Error("exporter factory must not run when flags are off");
    };
    const idle = createStageTracer({ createExporter: idleFactory });
    await idle.runStage("workflow.step", { taskId: "t-off", worktreeId: "" }, async () => "ok");
    expect(idle.finished()[0]?.attributes.task_id).toBe("t-off");

    const seen: string[] = [];
    const exportedTaskIds: string[] = [];
    const wired = createStageTracer({
      targets: resolveExporterTargets(loadTelemetryExportConfig({ OPTIO_OTEL_SIGNOZ: "true" })),
      createExporter(target) {
        seen.push(`${target.name} ${target.endpoint}`);
        return {
          export(spans, callback) {
            for (const span of spans) {
              const taskId = span.attributes.task_id;
              if (typeof taskId === "string") exportedTaskIds.push(taskId);
            }
            callback({ code: 0 });
          },
          shutdown: async () => {},
        };
      },
    });
    await wired.runStage(
      "workflow.step",
      { taskId: "t-sig", worktreeId: "wt-sig", attributes: { step_id: "plan" } },
      async () => "ok",
    );
    expect(seen).toEqual(["signoz http://127.0.0.1:4318/v1/traces"]);
    expect(exportedTaskIds).toEqual(["t-sig"]);
    expect(wired.finished()[0]?.attributes.worktree_id).toBe("wt-sig");
    await idle.shutdown();
    await wired.shutdown();
  });
});

describe("local trace sample", () => {
  it("records an exporters-off pipeline run tagged with task_id and worktree_id", () => {
    const trace = JSON.parse(readFileSync("docs/traces/local-pipeline.json", "utf8")) as {
      exporters: string[];
      intake: { name: string; task_id: string; worktree_id: string; status: string };
      stages: Array<{ step_id: string; task_id: string; worktree_id: string; status: string }>;
      planTrace: Array<{
        name: string;
        spanId: string;
        parentSpanId: string | null;
        attributes: Record<string, string>;
      }>;
    };
    expect(trace.exporters).toEqual([]);
    expect(trace.intake).toMatchObject({
      name: "intake.webhook",
      task_id: "t-local",
      worktree_id: "",
      status: "ok",
    });
    expect(trace.stages.map((stage) => stage.step_id)).toEqual([
      "plan",
      "implement",
      "review",
      "ready",
      "merge",
    ]);
    for (const stage of trace.stages) {
      expect(stage.task_id).toBe("t-local");
      expect(stage.worktree_id).toBe("");
      expect(stage.status).toBe("ok");
    }
    const stage = trace.planTrace.find((span) => span.name === "workflow.step");
    expect(stage?.attributes.task_id).toBe("t-local");
    expect(stage?.attributes.worktree_id).toBe("");
    const agents = trace.planTrace.filter((span) => span.name === "agent.run");
    expect(agents.length).toBeGreaterThan(0);
    for (const agent of agents) {
      expect(agent.parentSpanId).toBe(stage?.spanId);
      expect(agent.attributes.task_id).toBe("t-local");
      expect(agent.attributes.worktree_id).toBe("");
    }
  });
});

describe("collector stub", () => {
  it("exposes an OTLP receiver and a debug trace pipeline", () => {
    const yaml = readFileSync("deploy/otel-collector-config.yaml", "utf8");
    expect(yaml).toContain("endpoint: 0.0.0.0:4317");
    expect(yaml).toContain("endpoint: 0.0.0.0:4318");
    expect(yaml).toContain("debug:");
    expect(yaml).toContain("exporters: [debug]");
    expect(yaml).not.toContain("loglevel:");

    const compose = readFileSync("docker-compose.yml", "utf8");
    expect(compose).toContain("deploy/otel-collector-config.yaml");
    expect(compose).toContain("127.0.0.1:4318:4318");
    expect(compose).toContain("OPTIO_OTEL_LANGFUSE:");
    expect(compose).toContain("OPTIO_OTEL_SIGNOZ:");
  });
});
