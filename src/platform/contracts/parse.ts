import {
  EVENT_TYPES,
  type EventType,
  type PlatformEvent,
  eventSchema,
  supportedVersions,
} from "./events.js";

export class EventParseError extends Error {}

export class UnknownEventTypeError extends EventParseError {
  constructor(readonly type: unknown) {
    super(`unknown event type: ${String(type)}`);
    this.name = "UnknownEventTypeError";
  }
}

export class UnsupportedSchemaVersionError extends EventParseError {
  constructor(
    readonly type: EventType,
    readonly schemaVersion: unknown,
  ) {
    super(`unsupported schema_version ${String(schemaVersion)} for event type ${type}`);
    this.name = "UnsupportedSchemaVersionError";
  }
}

export class InvalidEventError extends EventParseError {
  constructor(
    message: string,
    readonly issues: readonly unknown[] = [],
  ) {
    super(message);
    this.name = "InvalidEventError";
  }
}

const isEventType = (v: unknown): v is EventType =>
  typeof v === "string" && (EVENT_TYPES as string[]).includes(v);

/** Parse an unknown value into a typed event, or throw an `EventParseError` subclass. */
export function parseEvent(input: unknown): PlatformEvent {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new InvalidEventError("event must be an object");
  }
  const { type, schema_version: version } = input as Record<string, unknown>;
  if (!isEventType(type)) throw new UnknownEventTypeError(type);
  if (typeof version !== "number" || !supportedVersions[type].includes(version)) {
    throw new UnsupportedSchemaVersionError(type, version);
  }
  const result = eventSchema(type).safeParse(input);
  if (!result.success) {
    throw new InvalidEventError(
      `invalid ${type} event: ${result.error.message}`,
      result.error.issues,
    );
  }
  return result.data as PlatformEvent;
}
