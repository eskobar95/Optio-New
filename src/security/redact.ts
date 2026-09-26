/**
 * Shared secret redaction for stage logs, exported spans, and agent dumps.
 * Named Optio env values and common key shapes are replaced with [redacted].
 * Hex ids (trace ids, UUIDs, SHA-256 fingerprints) are left in place.
 */

export const REDACTED = "[redacted]";

/** Env names whose assigned values are secrets, even when the value has no key prefix. */
export const SECRET_ENV_NAMES = [
  "CURSOR_API_KEY",
  "OPTIO_NEW_GITHUB_TOKEN",
  "MODEL_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "LITELLM_MASTER_KEY",
  "OPTIO_NEW_INTAKE_WEBHOOK_SECRET",
  "OPTIO_NEW_GITHUB_WEBHOOK_SECRET",
  "OPTIO_NEW_POSTGRES_PASSWORD",
  "OPTIO_NEW_DATABASE_URL",
  "OPTIO_NEW_REDIS_URL",
  "OPTIO_NEW_JEV_API_KEY",
  "JEV_API_KEY",
  "LAYA_API_KEY",
  "LANGFUSE_SECRET_KEY",
  "CAVE_API_KEY",
  "OPTIO_NEW_BACKUP_PASSWORD",
  "GITHUB_TOKEN",
  "GH_TOKEN",
] as const;

const PEM_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

const URL_USERINFO_RE = /([a-z][a-z0-9+.-]*:\/\/)([^:\s/@]*):([^@\s/]+)@/gi;

const ENV_ASSIGN_RE = new RegExp(
  `\\b(${SECRET_ENV_NAMES.join("|")})\\b\\s*["']?\\s*[:=]\\s*["']?([^\\s"'\`,;}]+)`,
  "g",
);

const GENERIC_ASSIGN_RE =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|webhook[_-]?secret|password|passwd)\b["']?\s*[:=]\s*["']?([^\s"'`,;}]+)/gi;

const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const BASIC_RE = /\bBasic\s+[A-Za-z0-9+/=]{8,}/g;

const KEY_SHAPES: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{8,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{8,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bcrsr_[A-Za-z0-9]{8,}\b/g,
];

const HIGH_ENTROPY_RE =
  /\b(?=[A-Za-z0-9+_=.-]*[A-Z])(?=[A-Za-z0-9+_=.-]*[a-z])(?=[A-Za-z0-9+_=.-]*\d)[A-Za-z0-9+_=.-]{32,}\b/g;

function replaceAssignment(match: string, value: string): string {
  if (!value || value === REDACTED) return match;
  return match.slice(0, match.length - value.length) + REDACTED;
}

function isHexish(token: string): boolean {
  return /^[0-9a-fA-F-]+$/.test(token);
}

/** Replace secret material in a single string. Safe to run more than once. */
export function redactSecrets(input: string): string {
  let out = input.replace(PEM_RE, REDACTED);
  out = out.replace(URL_USERINFO_RE, `$1$2:${REDACTED}@`);
  out = out.replace(ENV_ASSIGN_RE, (match, _name: string, value: string) =>
    replaceAssignment(match, value),
  );
  out = out.replace(GENERIC_ASSIGN_RE, (match, value: string) => replaceAssignment(match, value));
  out = out.replace(BEARER_RE, `Bearer ${REDACTED}`);
  out = out.replace(BASIC_RE, `Basic ${REDACTED}`);
  for (const pattern of KEY_SHAPES) out = out.replace(pattern, REDACTED);
  out = out.replace(HIGH_ENTROPY_RE, (token) => (isHexish(token) ? token : REDACTED));
  return out;
}

/** Walk JSON-like values and redact every string. */
export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (typeof value === "number" || typeof value === "boolean" || value == null) return value;
  if (value instanceof Error) {
    return { name: value.name, message: redactSecrets(value.message) };
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) out[key] = redactValue(inner);
    return out;
  }
  return value;
}

/** One JSON line for orchestrator stage logs. */
export function formatStageLog(record: Record<string, unknown>): string {
  return JSON.stringify(redactValue(record));
}

/** JSON dump of an agent result, audit row, or eve-runner payload. */
export function formatAgentDump(value: unknown): string {
  return JSON.stringify(redactValue(value));
}

/** Return the same error when it has no secret; otherwise a copy with a redacted message and stack. */
export function redactError<T>(error: T): T {
  if (!(error instanceof Error)) return error;
  const message = redactSecrets(error.message);
  const stack = error.stack ? redactSecrets(error.stack) : undefined;
  if (message === error.message && stack === error.stack) return error;
  const clone = new Error(message);
  clone.name = error.name;
  Object.setPrototypeOf(clone, Object.getPrototypeOf(error));
  if (stack) clone.stack = stack;
  const source = error as unknown as Record<string, unknown>;
  const target = clone as unknown as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(error)) {
    if (key === "message" || key === "stack" || key === "name") continue;
    const inner = source[key];
    target[key] = typeof inner === "string" ? redactSecrets(inner) : inner;
  }
  return clone as T;
}
