import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Ajv } from "ajv";
import {
  EVENT_TYPES,
  EventParseError,
  InvalidEventError,
  UnknownEventTypeError,
  UnsupportedSchemaVersionError,
  buildContractFiles,
  createUuidv7Generator,
  eventRegistry,
  parseEvent,
  uuidv7,
  writeContractFiles,
} from "../src/platform/contracts/index.js";

const GENERATED = join(import.meta.dirname, "../src/platform/contracts/generated");

function listFiles(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    if (!name.endsWith(".json")) continue;
    out[name] = readFileSync(join(dir, name), "utf8");
  }
  return out;
}

const omitBody = (p: Record<string, unknown>) => {
  const { body: _b, blob: _r, ...rest } = p;
  return rest;
};

describe("uuidv7", () => {
  it("has version 7 and RFC variant bits", () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("sorts by time when generated in sequence", () => {
    const ids = Array.from({ length: 5000 }, () => uuidv7());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("encodes the clock in the first 48 bits", () => {
    const id = createUuidv7Generator(() => 1_700_000_000_000)();
    expect(parseInt(id.replace(/-/g, "").slice(0, 12), 16)).toBe(1_700_000_000_000);
  });

  it("stays ordered within one millisecond and when the clock goes backwards", () => {
    let now = 2_000_000_000_000;
    const gen = createUuidv7Generator(() => now);
    const ids: string[] = [];
    for (let i = 0; i < 10_000; i++) ids.push(gen());
    now = 1_000_000_000_000;
    for (let i = 0; i < 10; i++) ids.push(gen());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("event registry", () => {
  it("covers every required type with a version", () => {
    expect([...EVENT_TYPES].sort()).toEqual(
      [
        "run.started",
        "run.ended",
        "turn",
        "usage",
        "tool",
        "status",
        "error",
        "gate.requested",
        "gate.decided",
        "signoff",
        "skill_pick",
        "failure",
        "artifact",
        "membership.changed",
        "project.created",
      ].sort(),
    );
    for (const type of EVENT_TYPES) {
      expect(eventRegistry[type].version).toBeGreaterThanOrEqual(1);
    }
  });

  it.each([...EVENT_TYPES])("%s fixture parses through parseEvent", (type) => {
    const fixture = eventRegistry[type].fixture;
    expect(parseEvent(fixture).type).toBe(type);
  });
});

describe("parseEvent", () => {
  const usage = () => structuredClone(eventRegistry["usage"].fixture) as Record<string, unknown>;

  it("rejects an unknown type with a typed error", () => {
    const e = { ...usage(), type: "nope" };
    expect(() => parseEvent(e)).toThrow(UnknownEventTypeError);
    expect(() => parseEvent(e)).toThrow(EventParseError);
  });

  it("rejects an unknown schema_version with a typed error", () => {
    const e = { ...usage(), schema_version: 999 };
    try {
      parseEvent(e);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedSchemaVersionError);
      expect((err as UnsupportedSchemaVersionError).type).toBe("usage");
      expect((err as UnsupportedSchemaVersionError).schemaVersion).toBe(999);
    }
  });

  it("rejects a malformed payload with InvalidEventError", () => {
    const e = usage();
    e.payload = { ...(e.payload as object), input: 1.5 };
    expect(() => parseEvent(e)).toThrow(InvalidEventError);
  });

  it("rejects non-UUIDv7 ids and non-object input", () => {
    expect(() => parseEvent({ ...usage(), id: "00000000-0000-4000-8000-000000000000" })).toThrow(
      InvalidEventError,
    );
    expect(() => parseEvent(null)).toThrow(InvalidEventError);
  });

  it("usage carries integers only, including cost_micros", () => {
    const e = usage();
    e.payload = { ...(e.payload as object), cost_micros: 0.5 };
    expect(() => parseEvent(e)).toThrow(InvalidEventError);
  });

  it("turn and artifact accept an inline body or a blob ref, not both nor neither", () => {
    for (const type of ["turn", "artifact"] as const) {
      const base = structuredClone(eventRegistry[type].fixture) as Record<string, any>;
      const payload = base.payload;
      const blob = { sha256: "a".repeat(64), size: 20000 };
      const { body: _b, blob: _r, ...common } = payload;
      const inline = { ...common, body: "hello" };
      const ref = { ...common, blob };
      expect(() => parseEvent({ ...base, payload: inline })).not.toThrow();
      expect(() => parseEvent({ ...base, payload: ref })).not.toThrow();
      expect(() => parseEvent({ ...base, payload: { ...payload, body: "x", blob } })).toThrow(
        InvalidEventError,
      );
      expect(() =>
        parseEvent({ ...base, payload: { ...payload, body: undefined, blob: undefined } }),
      ).toThrow(InvalidEventError);
    }
  });

  it("rejects an inline body over the size limit", () => {
    const base = structuredClone(eventRegistry["turn"].fixture) as Record<string, any>;
    const big = "x".repeat(16 * 1024 + 1);
    expect(() =>
      parseEvent({ ...base, payload: { ...omitBody(base.payload), body: big } }),
    ).toThrow(InvalidEventError);
  });
});

describe("contracts export", () => {
  const files = buildContractFiles();

  it("writes one JSON Schema and one fixture per type", () => {
    for (const type of EVENT_TYPES) {
      expect(files[`schemas/${type}.schema.json`]).toBeDefined();
      expect(files[`fixtures/${type}.json`]).toBeDefined();
    }
  });

  it.each([...EVENT_TYPES])("%s fixture validates against its JSON Schema", (type) => {
    const schema = JSON.parse(files[`schemas/${type}.schema.json`]!);
    expect(schema.properties.type.const).toBe(type);
    expect(schema.properties.schema_version.const).toBe(eventRegistry[type].version);
    const validate = new Ajv({ strict: false, validateFormats: false }).compile(schema);
    const fixture = JSON.parse(files[`fixtures/${type}.json`]!);
    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...fixture, schema_version: 0 })).toBe(false);
  });

  it("is deterministic and matches the checked-in generated files (no diff)", () => {
    const dir = mkdtempSync(join(tmpdir(), "contracts-"));
    writeContractFiles(dir);
    expect(listFiles(dir)).toEqual(listFiles(GENERATED));
    expect(Object.keys(listFiles(GENERATED)).length).toBe(EVENT_TYPES.length * 2);
  });
});
