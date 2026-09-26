/**
 * Langfuse and SigNoz OTLP export. Both default off.
 * Only the string "true" (any case) enables an exporter.
 */

export interface TelemetryExportConfig {
  langfuse: boolean;
  signoz: boolean;
  langfuseEndpoint: string;
  signozEndpoint: string;
  langfusePublicKey: string;
  langfuseSecretKey: string;
}

export interface ExporterTarget {
  name: "langfuse" | "signoz";
  endpoint: string;
  headers?: Record<string, string>;
}

const DEFAULT_LANGFUSE_HOST = "http://127.0.0.1:3000";
const DEFAULT_SIGNOZ_ENDPOINT = "http://127.0.0.1:4318/v1/traces";

function enabled(value: string | undefined): boolean {
  return (value ?? "").trim().toLowerCase() === "true";
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function loadTelemetryExportConfig(
  env: NodeJS.ProcessEnv = process.env,
): TelemetryExportConfig {
  const host = trimSlash(nonEmpty(env.LANGFUSE_HOST) ?? DEFAULT_LANGFUSE_HOST);
  return {
    langfuse: enabled(env.OPTIO_OTEL_LANGFUSE),
    signoz: enabled(env.OPTIO_OTEL_SIGNOZ),
    langfuseEndpoint:
      nonEmpty(env.OPTIO_LANGFUSE_OTLP_ENDPOINT) ?? `${host}/api/public/otel/v1/traces`,
    signozEndpoint: nonEmpty(env.OPTIO_SIGNOZ_OTLP_ENDPOINT) ?? DEFAULT_SIGNOZ_ENDPOINT,
    langfusePublicKey: env.LANGFUSE_PUBLIC_KEY ?? "",
    langfuseSecretKey: env.LANGFUSE_SECRET_KEY ?? "",
  };
}

/** Exporter targets for the flags that are on. Empty when both flags are off. */
export function resolveExporterTargets(config: TelemetryExportConfig): ExporterTarget[] {
  const targets: ExporterTarget[] = [];
  if (config.langfuse) {
    const target: ExporterTarget = {
      name: "langfuse",
      endpoint: config.langfuseEndpoint,
    };
    if (config.langfusePublicKey && config.langfuseSecretKey) {
      const token = Buffer.from(`${config.langfusePublicKey}:${config.langfuseSecretKey}`).toString(
        "base64",
      );
      target.headers = { Authorization: `Basic ${token}` };
    }
    targets.push(target);
  }
  if (config.signoz) {
    targets.push({ name: "signoz", endpoint: config.signozEndpoint });
  }
  return targets;
}
