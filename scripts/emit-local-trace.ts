/**
 * Record one in-process pipeline trace (exporters off) for docs/traces.
 * Run: npx tsx scripts/emit-local-trace.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  InMemoryStepCursorStore,
  createAgentStageHandler,
  createStageTracer,
  enqueueIntakePipeline,
  processStageJob,
  runPipeline,
  type FinishedSpan,
} from "../src/index.js";

const taskId = "t-local";
const sessionId = "s-local";

function project(span: FinishedSpan) {
  return {
    name: span.name,
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId ?? null,
    status: span.status,
    attributes: span.attributes,
  };
}

const tracer = createStageTracer();
await enqueueIntakePipeline(
  { taskId, title: "observability", description: "issue 13" },
  {
    async add() {
      return { id: "local" };
    },
  },
  sessionId,
  tracer,
);

const pipeline = await runPipeline(
  { taskId, sessionId },
  {
    cursors: new InMemoryStepCursorStore(),
    handler: { async run() {} },
    tracer,
    worktreeId: "",
  },
);

const planTracer = createStageTracer();
await processStageJob(
  { taskId, sessionId, stage: "plan" },
  {
    cursors: new InMemoryStepCursorStore(),
    handler: createAgentStageHandler({
      async complete() {
        return { text: "ok" };
      },
    }),
    tracer: planTracer,
    worktreeId: "",
  },
);

const spans = tracer.finished();
const stages = pipeline.stages.map((stage) => {
  const span = spans.find(
    (item) => item.name === "workflow.step" && item.attributes.step_id === stage.stage,
  );
  return {
    step_id: stage.stage,
    task_id: span?.attributes.task_id ?? "",
    worktree_id: span?.attributes.worktree_id ?? "",
    status: span?.status ?? "error",
    traceId: span?.traceId ?? "",
    spanId: span?.spanId ?? "",
  };
});

const intake = spans.find((span) => span.name === "intake.webhook");
const document = {
  exporters: [] as string[],
  intake: intake
    ? {
        name: intake.name,
        task_id: intake.attributes.task_id,
        worktree_id: intake.attributes.worktree_id,
        session_id: intake.attributes.session_id,
        status: intake.status,
        traceId: intake.traceId,
        spanId: intake.spanId,
      }
    : null,
  stages,
  planTrace: planTracer.finished().map(project),
};

const out = path.resolve("docs/traces/local-pipeline.json");
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);
await tracer.shutdown();
await planTracer.shutdown();
console.log(`wrote ${out}`);
