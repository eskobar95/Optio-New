export {
  loadTelemetryExportConfig,
  resolveExporterTargets,
  type ExporterTarget,
  type TelemetryExportConfig,
} from "./config.js";
export { CANONICAL_SPAN, readStringField, type CanonicalSpanName } from "./spans.js";
export {
  createStageTracer,
  getStageTracer,
  type ActiveSpan,
  type FinishedSpan,
  type SpanFields,
  type StageTracer,
  type StageTracerOptions,
} from "./tracer.js";
