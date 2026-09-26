/**
 * ACI-style observations for the Cursor implement stage.
 * Prompt policy for the headless subscription CLI. Not a second agent runtime.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

import type { CodingAgentInput } from "../coding-agent.js";
import { buildAgentPrompt } from "../runtime.js";

const require = createRequire(import.meta.url);

export const EMPTY_COMMAND_OBSERVATION = "Command succeeded with no output.";
export const DEFAULT_SEARCH_SUMMARY_LIMIT = 20;
export const MAX_SEARCH_SUMMARY_LIMIT = 50;

const SEARCH_LINE_CHARS = 160;
const MAX_DIAGNOSTICS = 5;

const IMPLEMENT_STEPS = new Set(["implementation", "invoke_implementation"]);

export const CURSOR_IMPLEMENT_ACI_POLICY = [
  "## Implement feedback policy",
  "",
  "Cursor implement-stage policy for the headless CLI on the Hetzner host. Stay on the subscription path: CURSOR_API_KEY to https://api2.cursor.sh. This is prompt policy for that same Cursor process.",
  "",
  "- After each file edit, run a syntax check. When the check fails, restore the previous file contents. The edit is rolled back. The observation names the file and the syntax error.",
  "- Search and list tools return a short summary: how many lines are shown, those lines, and how many were omitted.",
  `- When a command exits 0 and prints nothing, the observation is: ${EMPTY_COMMAND_OBSERVATION}`,
].join("\n");

export interface LintDiagnostic {
  line: number;
  column?: number;
  message: string;
}

export interface FileEdit {
  path: string;
  before: string;
  after: string;
}

export interface EditGateResult {
  blocked: boolean;
  content: string;
  observation: string;
}

export type SyntaxChecker = (source: string, path: string) => readonly LintDiagnostic[];

export function isCursorImplementStep(stepId: string | undefined): boolean {
  return IMPLEMENT_STEPS.has(stepId ?? "");
}

export function cursorImplementPrompt(
  input: Pick<CodingAgentInput, "prompt" | "instructions" | "metadata">,
): string {
  const base = buildAgentPrompt(input as CodingAgentInput);
  if (!isCursorImplementStep(input.metadata.step_id)) return base;
  return `${base}\n\n${CURSOR_IMPLEMENT_ACI_POLICY}`;
}

export function gateFileEdit(edit: FileEdit, check: SyntaxChecker = checkSyntax): EditGateResult {
  let diagnostics: readonly LintDiagnostic[];
  try {
    diagnostics = check(edit.after, edit.path);
  } catch (error) {
    const message = error instanceof Error ? error.message : "syntax check failed";
    diagnostics = [{ line: 1, message }];
  }
  if (diagnostics.length === 0) {
    return {
      blocked: false,
      content: edit.after,
      observation: `Edit accepted for ${edit.path}.`,
    };
  }
  const shown = diagnostics.slice(0, MAX_DIAGNOSTICS).map(formatDiagnostic);
  const hidden = diagnostics.length - shown.length;
  if (hidden > 0) shown.push(`(${hidden} more)`);
  return {
    blocked: true,
    content: edit.before,
    observation: [
      `Edit blocked for ${edit.path}: syntax check failed. Change rolled back.`,
      ...shown,
    ].join("\n"),
  };
}

export function checkSyntax(source: string, filePath: string): LintDiagnostic[] {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    return checkJavaScript(source, ext);
  }
  if (ext === ".ts" || ext === ".mts" || ext === ".cts") {
    return checkTypeScript(source, ext);
  }
  return [];
}

export function summarizeSearch(input: {
  tool: "search" | "list";
  items: readonly string[];
  limit?: number;
}): string {
  const noun = input.tool === "list" ? "entries" : "matches";
  if (input.items.length === 0) {
    return input.tool === "list" ? "No entries." : "No matches.";
  }
  const limit = clampLimit(input.limit);
  const shown = input.items.slice(0, limit).map(oneLine);
  const omitted = input.items.length - shown.length;
  const header =
    omitted === 0
      ? `Showing ${shown.length} ${noun}.`
      : `Showing ${shown.length} of ${input.items.length} ${noun}.`;
  const lines = [header, ...shown];
  if (omitted > 0) lines.push(`(${omitted} more omitted)`);
  return lines.join("\n");
}

export function formatCommandObservation(input: {
  exitCode: number | null;
  stdout: string;
  stderr?: string;
}): string {
  const stdout = input.stdout ?? "";
  const stderr = (input.stderr ?? "").trim();
  const stdoutEmpty = stdout.trim().length === 0;
  if (input.exitCode === 0) {
    if (stdoutEmpty && stderr.length === 0) return EMPTY_COMMAND_OBSERVATION;
    if (stdoutEmpty) return `${EMPTY_COMMAND_OBSERVATION}\n${stderr}`;
    return stdout;
  }
  if (input.exitCode === null) {
    if (stdoutEmpty && stderr.length === 0) return "Command finished with no output.";
    const parts = ["Command finished."];
    if (!stdoutEmpty) parts.push(stdout.trim());
    if (stderr.length > 0) parts.push(stderr);
    return parts.join("\n");
  }
  const parts = [`Command failed (exit ${input.exitCode}).`];
  if (!stdoutEmpty) parts.push(stdout.trim());
  if (stderr.length > 0) parts.push(stderr);
  return parts.join("\n");
}

function formatDiagnostic(diagnostic: LintDiagnostic): string {
  const message = diagnostic.message.trim() || "syntax check failed";
  const column =
    diagnostic.column !== undefined && diagnostic.column > 0 ? `:C${diagnostic.column}` : "";
  return `L${diagnostic.line}${column}: ${message}`;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_SEARCH_SUMMARY_LIMIT;
  return Math.min(MAX_SEARCH_SUMMARY_LIMIT, Math.max(0, Math.floor(limit)));
}

function oneLine(item: string): string {
  const flat = item.replace(/\s+/g, " ").trim();
  if (!flat) return "(blank)";
  if (flat.length <= SEARCH_LINE_CHARS) return flat;
  return `${flat.slice(0, SEARCH_LINE_CHARS - 3)}...`;
}

function checkJavaScript(source: string, ext: ".js" | ".mjs" | ".cjs"): LintDiagnostic[] {
  const dir = mkdtempSync(join(tmpdir(), "optio-aci-"));
  try {
    const fileExt = ext === ".cjs" ? ".cjs" : ext === ".mjs" ? ".mjs" : ".js";
    if (fileExt !== ".cjs") {
      writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
    }
    const file = join(dir, `snippet${fileExt}`);
    writeFileSync(file, source);
    return runNodeCheck(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function checkTypeScript(source: string, ext: ".ts" | ".mts" | ".cts"): LintDiagnostic[] {
  const stripped = stripTypes(source);
  if (stripped.kind === "syntax") return [stripped.diagnostic];
  if (stripped.kind === "ok") {
    const outExt = ext === ".cts" ? ".cjs" : ext === ".mts" ? ".mjs" : ".js";
    return checkJavaScript(stripped.code, outExt);
  }
  const fromTypescript = checkWithTypescript(source, `snippet${ext}`);
  if (fromTypescript) return fromTypescript;
  return [{ line: 1, message: "syntax check unavailable" }];
}

function stripTypes(
  source: string,
):
  | { kind: "ok"; code: string }
  | { kind: "syntax"; diagnostic: LintDiagnostic }
  | { kind: "unavailable" } {
  const strip = (
    require("node:module") as {
      stripTypeScriptTypes?: (code: string) => string;
    }
  ).stripTypeScriptTypes;
  if (typeof strip !== "function") return { kind: "unavailable" };
  try {
    const code = withoutExperimentalWarning(() => strip(source));
    return { kind: "ok", code };
  } catch (error) {
    return { kind: "syntax", diagnostic: diagnosticFromStrip(error) };
  }
}

function diagnosticFromStrip(error: unknown): LintDiagnostic {
  const raw = error instanceof Error ? error.message : "syntax check failed";
  const marked = raw.match(/\bx\s+([^\n]+)/);
  const syntax = raw.match(/SyntaxError:\s*(.+)/);
  const summary = (
    marked?.[1] ??
    syntax?.[1] ??
    raw.split("\n")[0] ??
    "syntax check failed"
  ).trim();
  const lineMatch = raw.match(/(?:^|\n)\s*(\d+)\s*\|/);
  return {
    line: lineMatch ? Number(lineMatch[1]) : 1,
    message: cleanMessage(summary),
  };
}

interface TypescriptDiagnostic {
  category: number;
  messageText: unknown;
  start?: number;
  file?: { getLineAndCharacterOfPosition(pos: number): { line: number } };
}

interface TypescriptSyntax {
  transpileModule(
    source: string,
    options: {
      fileName: string;
      reportDiagnostics: boolean;
      compilerOptions: Record<string, number>;
    },
  ): { diagnostics?: TypescriptDiagnostic[] };
  ScriptTarget: { ES2022: number };
  ModuleKind: { ESNext: number };
  DiagnosticCategory: { Error: number };
  flattenDiagnosticMessageText(message: unknown, newLine: string): string;
}

function checkWithTypescript(source: string, fileName: string): LintDiagnostic[] | null {
  let ts: TypescriptSyntax;
  try {
    ts = require("typescript") as TypescriptSyntax;
  } catch {
    return null;
  }
  const result = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  });
  const errors = (result.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  return errors.map((diagnostic) => {
    let line = 1;
    if (diagnostic.file && diagnostic.start !== undefined) {
      line = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1;
    }
    return {
      line,
      message: cleanMessage(ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")),
    };
  });
}

function runNodeCheck(file: string): LintDiagnostic[] {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status === 0) return [];
  return [parseCheckFailure(`${result.stderr ?? ""}\n${result.stdout ?? ""}`, file)];
}

function parseCheckFailure(stderr: string, file: string): LintDiagnostic {
  const syntax = stderr.match(/SyntaxError:\s*(.+)/);
  const marker = `${file}:`;
  const at = stderr.indexOf(marker);
  let line = 1;
  if (at >= 0) {
    const digits = /^(\d+)/.exec(stderr.slice(at + marker.length));
    if (digits) line = Number(digits[1]);
  }
  return {
    line,
    message: cleanMessage(syntax?.[1] ?? "syntax check failed"),
  };
}

function cleanMessage(message: string): string {
  return message.trim().replace(/\.$/, "").slice(0, 180);
}

function withoutExperimentalWarning<T>(fn: () => T): T {
  const emit = process.emitWarning;
  process.emitWarning = ((warning: unknown, ...args: unknown[]) => {
    const text =
      typeof warning === "string" ? warning : warning instanceof Error ? warning.message : "";
    if (text.includes("stripTypeScriptTypes") || text.includes("Type Stripping")) return;
    return Reflect.apply(emit, process, [warning, ...args]) as void;
  }) as typeof process.emitWarning;
  try {
    return fn();
  } finally {
    process.emitWarning = emit;
  }
}
