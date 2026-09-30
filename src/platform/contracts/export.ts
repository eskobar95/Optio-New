import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod/v4";
import { EVENT_TYPES } from "./events.js";
import { eventRegistry } from "./registry.js";

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/** Relative path to file content: one JSON Schema and one fixture per event type. */
export function buildContractFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const type of EVENT_TYPES) {
    const entry = eventRegistry[type];
    files[`schemas/${type}.schema.json`] = json(
      z.toJSONSchema(entry.schema, { target: "draft-7" }),
    );
    files[`fixtures/${type}.json`] = json(entry.fixture);
  }
  return files;
}

export function writeContractFiles(outDir: string): void {
  for (const [rel, content] of Object.entries(buildContractFiles())) {
    const path = join(outDir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}
