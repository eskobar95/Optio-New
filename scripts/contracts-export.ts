/**
 * Write JSON Schema and fixtures for every event type.
 * Run: npm run contracts:export
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { writeContractFiles } from "../src/platform/contracts/export.js";

const outDir = join(import.meta.dirname, "../src/platform/contracts/generated");
rmSync(outDir, { recursive: true, force: true });
writeContractFiles(outDir);
console.log(`wrote contracts to ${outDir}`);
