/**
 * JSON file step cursor for the host chaos proof.
 * Production resume uses Postgres (`createPgStepCursorStore`). This store lets a
 * killed process and its replacement share one cursor without a database.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { PIPELINE_STAGES, type PipelineStage } from "./stages.js";
import {
  STEP_CURSOR_STATUSES,
  type StepCursor,
  type StepCursorStatus,
  type StepCursorStore,
} from "./cursor.js";

interface FileShape {
  rows: Record<string, StepCursor>;
}

function cursorKey(taskId: string, sessionId: string, stage: PipelineStage): string {
  return `${taskId}|${sessionId}|${stage}`;
}

function isStage(value: string): value is PipelineStage {
  return (PIPELINE_STAGES as readonly string[]).includes(value);
}

function isStatus(value: string): value is StepCursorStatus {
  return (STEP_CURSOR_STATUSES as readonly string[]).includes(value);
}

function parseCursor(value: unknown): StepCursor {
  if (!value || typeof value !== "object") {
    throw new Error("invalid file step cursor");
  }
  const row = value as StepCursor;
  if (typeof row.taskId !== "string" || typeof row.sessionId !== "string") {
    throw new Error("invalid file step cursor identity");
  }
  if (typeof row.stage !== "string" || !isStage(row.stage)) {
    throw new Error("invalid file step cursor stage");
  }
  if (typeof row.status !== "string" || !isStatus(row.status)) {
    throw new Error("invalid file step cursor status");
  }
  if (!Number.isInteger(row.nextStepIndex) || row.nextStepIndex < 0) {
    throw new Error("invalid file step cursor nextStepIndex");
  }
  if (typeof row.updatedAt !== "string" || row.updatedAt.length === 0) {
    throw new Error("invalid file step cursor updatedAt");
  }
  return {
    taskId: row.taskId,
    sessionId: row.sessionId,
    stage: row.stage,
    nextStepIndex: row.nextStepIndex,
    status: row.status,
    updatedAt: row.updatedAt,
  };
}

async function readRows(filePath: string): Promise<Map<string, StepCursor>> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return new Map();
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || !("rows" in parsed)) {
    throw new Error("invalid file step cursor document");
  }
  const rows = (parsed as FileShape).rows;
  if (!rows || typeof rows !== "object") {
    throw new Error("invalid file step cursor document");
  }
  const map = new Map<string, StepCursor>();
  for (const [key, value] of Object.entries(rows)) {
    map.set(key, parseCursor(value));
  }
  return map;
}

async function writeRows(filePath: string, rows: Map<string, StepCursor>): Promise<void> {
  const body: FileShape = { rows: Object.fromEntries(rows) };
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  await writeFile(tmp, `${JSON.stringify(body)}\n`, "utf8");
  await rename(tmp, filePath);
}

export class JsonFileStepCursorStore implements StepCursorStore {
  constructor(private readonly filePath: string) {}

  async get(
    taskId: string,
    sessionId: string,
    stage: PipelineStage,
  ): Promise<StepCursor | undefined> {
    const rows = await readRows(this.filePath);
    const found = rows.get(cursorKey(taskId, sessionId, stage));
    return found ? { ...found } : undefined;
  }

  async save(cursor: StepCursor): Promise<void> {
    const rows = await readRows(this.filePath);
    rows.set(cursorKey(cursor.taskId, cursor.sessionId, cursor.stage), { ...cursor });
    await writeRows(this.filePath, rows);
  }
}
