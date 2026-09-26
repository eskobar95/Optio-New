/**
 * In-process OpenTelemetry spans for orchestrator stages.
 * OTLP export is attached only for targets passed in (env flags default off).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  isSpanContextValid,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type Span,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { redactError, redactSecrets } from "../../security/redact.js";
import {
  loadTelemetryExportConfig,
  resolveExporterTargets,
  type ExporterTarget,
} from "./config.js";

export interface SpanFields {
  taskId: string;
  /** Omitted values are recorded as an empty `worktree_id`. */
  worktreeId?: string;
  attributes?: Record<string, string>;
}

export interface FinishedSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  status: "ok" | "error";
  attributes: Record<string, string>;
}

export interface ActiveSpan {
  setAttribute(key: string, value: string): void;
  setName(name: string): void;
  /** Mark the span failed without throwing. Used by gate.fail. */
  fail(message?: string): void;
}

export interface StageTracer {
  runStage<T>(
    name: string,
    fields: SpanFields,
    fn: (span: ActiveSpan) => Promise<T> | T,
  ): Promise<T>;
  finished(): FinishedSpan[];
  shutdown(): Promise<void>;
}

export interface StageTracerOptions {
  targets?: readonly ExporterTarget[];
  createExporter?: (target: ExporterTarget) => SpanExporter;
}

function attributesOf(fields: SpanFields): Record<string, string> {
  const attributes: Record<string, string> = {
    task_id: redactSecrets(fields.taskId),
    worktree_id: redactSecrets(fields.worktreeId ?? ""),
  };
  if (fields.attributes) {
    for (const [key, value] of Object.entries(fields.attributes)) {
      if (key === "task_id" || key === "worktree_id") continue;
      attributes[key] = redactSecrets(value);
    }
  }
  return attributes;
}

function toFinished(span: ReadableSpan): FinishedSpan {
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(span.attributes)) {
    if (typeof value === "string") attributes[key] = redactSecrets(value);
    else if (typeof value === "number" || typeof value === "boolean")
      attributes[key] = redactSecrets(String(value));
  }
  if (attributes.task_id === undefined) attributes.task_id = "";
  if (attributes.worktree_id === undefined) attributes.worktree_id = "";

  const parent = span.parentSpanContext;
  const parentSpanId = parent && isSpanContextValid(parent) ? parent.spanId : undefined;
  return {
    name: span.name,
    traceId: span.spanContext().traceId,
    spanId: span.spanContext().spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    status: span.status.code === SpanStatusCode.ERROR ? "error" : "ok",
    attributes,
  };
}

function defaultOtlpExporter(target: ExporterTarget): SpanExporter {
  return new OTLPTraceExporter({
    url: target.endpoint,
    headers: target.headers,
  });
}

export function createStageTracer(options: StageTracerOptions = {}): StageTracer {
  const memory = new InMemorySpanExporter();
  const createExporter = options.createExporter ?? defaultOtlpExporter;
  const processors = [
    new SimpleSpanProcessor(memory),
    ...(options.targets ?? []).map((target) => new SimpleSpanProcessor(createExporter(target))),
  ];
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ "service.name": "optio-new" }),
    spanProcessors: processors,
  });
  const otel = provider.getTracer("optio-new");
  const storage = new AsyncLocalStorage<Span>();

  return {
    async runStage(name, fields, fn) {
      const parentSpan = storage.getStore();
      const parentCtx = parentSpan ? trace.setSpan(ROOT_CONTEXT, parentSpan) : ROOT_CONTEXT;
      const span = otel.startSpan(name, { attributes: attributesOf(fields) }, parentCtx);
      let failed = false;
      let failMessage: string | undefined;
      const active: ActiveSpan = {
        setAttribute(key, value) {
          span.setAttribute(key, redactSecrets(value));
        },
        setName(next) {
          span.updateName(next);
        },
        fail(message) {
          failed = true;
          failMessage = message ? redactSecrets(message) : message;
        },
      };
      try {
        const result = await storage.run(span, () => fn(active));
        if (failed) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: failMessage });
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }
        return result;
      } catch (error) {
        const safe = redactError(error);
        const message = safe instanceof Error ? safe.message : redactSecrets(String(error));
        if (safe instanceof Error) {
          span.setAttribute("error_class", safe.name);
          span.recordException(safe);
        }
        span.setStatus({ code: SpanStatusCode.ERROR, message });
        throw safe;
      } finally {
        span.end();
      }
    },
    finished() {
      return memory.getFinishedSpans().map(toFinished);
    },
    shutdown() {
      return provider.shutdown();
    },
  };
}

let singleton: StageTracer | undefined;

/** Process-wide tracer. Reads export flags once, on first use. */
export function getStageTracer(env: NodeJS.ProcessEnv = process.env): StageTracer {
  if (!singleton) {
    singleton = createStageTracer({
      targets: resolveExporterTargets(loadTelemetryExportConfig(env)),
    });
  }
  return singleton;
}
