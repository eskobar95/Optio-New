/**
 * Per-task token and USD caps (issue #87).
 * The stage processor checks before and after agent runs.
 * A miss or an overage throws BudgetExceeded and does not advance the cursor.
 * Caps come from env or workflows/default-task.yaml. Defaults suit a Hetzner CX33
 * host in front of Vercel AI Gateway. See docs/task-budget.md.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { UnrecoverableError } from "bullmq";
import { parse } from "yaml";
import { z } from "zod";
import type { StageStepUsage } from "./stage-result.js";
import { PIPELINE_STAGES, type PipelineStage } from "./stages.js";
import type { SqlExecutor } from "./cursor.js";

/** 200k tokens: one plan+implement slice, not an unbounded agent loop. */
export const DEFAULT_TASK_MAX_TOKENS = 400_000;

/**
 * USD 2: Vercel AI Gateway is pass-through. At typical coding-model rates this is
 * well under a day of CX33-sized spend if a loop retries. Raise it in env or YAML.
 */
export const DEFAULT_TASK_MAX_USD = 2;

export const BUDGETED_AGENT_STEPS = [
  "invoke_planner",
  "invoke_implementation",
  "invoke_review",
] as const;

export type BudgetFailReason =
  "token_cap" | "usd_cap" | "stage_token_cap" | "stage_usd_cap" | "usage_unreported";

export interface StageBudgetCap {
  maxTokens?: number;
  maxUsd?: number;
}

export interface TaskBudgetCaps {
  maxTokens: number;
  maxUsd: number;
  stages?: Partial<Record<PipelineStage, StageBudgetCap>>;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface TaskUsageSnapshot {
  task: UsageTotals;
  stages: Partial<Record<PipelineStage, UsageTotals>>;
}

export interface UsageStore {
  get(taskId: string, sessionId: string): Promise<TaskUsageSnapshot>;
  add(
    taskId: string,
    sessionId: string,
    stage: PipelineStage,
    delta: UsageTotals,
    updatedAt: string,
  ): Promise<TaskUsageSnapshot>;
}

export interface BudgetBinding {
  caps: TaskBudgetCaps;
  usage: UsageStore;
  now?: () => Date;
  /** Defaults to console.log. The line is JSON and contains no secrets. */
  log?: (line: string) => void;
}

export interface TaskBudgetStatus {
  ok: true;
  taskId: string;
  sessionId: string;
  caps: {
    maxTokens: number;
    maxUsd: number;
    stages?: Partial<Record<PipelineStage, { maxTokens?: number; maxUsd?: number }>>;
  };
  usage: {
    inputTokens: number;
    outputTokens: number;
    tokens: number;
    costUsd: number;
    stages: Partial<
      Record<
        PipelineStage,
        { inputTokens: number; outputTokens: number; tokens: number; costUsd: number }
      >
    >;
  };
  exceeded: boolean;
  reason?: BudgetFailReason;
}

const ZERO: UsageTotals = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

const StageCapSchema = z
  .object({
    max_tokens: z.number().finite().nonnegative().optional(),
    max_usd: z.number().finite().nonnegative().optional(),
  })
  .strict();

const BudgetYamlSchema = z
  .object({
    max_tokens: z.number().finite().nonnegative().optional(),
    max_usd: z.number().finite().nonnegative().optional(),
    stages: z.record(z.enum(PIPELINE_STAGES), StageCapSchema).optional(),
  })
  .strict();

export function isBudgetedAgentStep(step: string): boolean {
  return (BUDGETED_AGENT_STEPS as readonly string[]).includes(step);
}

export function tokensOf(usage: UsageTotals): number {
  return usage.inputTokens + usage.outputTokens;
}

function emptySnapshot(): TaskUsageSnapshot {
  return { task: { ...ZERO }, stages: {} };
}

function addTotals(left: UsageTotals, right: UsageTotals): UsageTotals {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    costUsd: left.costUsd + right.costUsd,
  };
}

export class InMemoryUsageStore implements UsageStore {
  private readonly rows = new Map<string, Map<PipelineStage, UsageTotals>>();

  async get(taskId: string, sessionId: string): Promise<TaskUsageSnapshot> {
    return snapshotOf(this.rows.get(usageKey(taskId, sessionId)));
  }

  async add(
    taskId: string,
    sessionId: string,
    stage: PipelineStage,
    delta: UsageTotals,
    _updatedAt: string,
  ): Promise<TaskUsageSnapshot> {
    const key = usageKey(taskId, sessionId);
    const stages = this.rows.get(key) ?? new Map<PipelineStage, UsageTotals>();
    const current = stages.get(stage) ?? { ...ZERO };
    stages.set(stage, addTotals(current, delta));
    this.rows.set(key, stages);
    return snapshotOf(stages);
  }
}

function usageKey(taskId: string, sessionId: string): string {
  return `${taskId}|${sessionId}`;
}

function snapshotOf(stages: Map<PipelineStage, UsageTotals> | undefined): TaskUsageSnapshot {
  if (!stages) return emptySnapshot();
  const snapshot = emptySnapshot();
  for (const [stage, totals] of stages) {
    snapshot.stages[stage] = { ...totals };
    snapshot.task = addTotals(snapshot.task, totals);
  }
  return snapshot;
}

function readOptionalNumber(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number`);
  }
  return value;
}

function readYamlDocument(workflowYaml: string): Record<string, unknown> {
  const parsed: unknown = parse(workflowYaml);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("workflow YAML must be a map");
  }
  return parsed as Record<string, unknown>;
}

function capsFromYaml(workflowYaml: string | undefined): {
  maxTokens?: number;
  maxUsd?: number;
  stages?: TaskBudgetCaps["stages"];
} {
  if (!workflowYaml) return {};
  const doc = readYamlDocument(workflowYaml);
  if (doc.budget === undefined) return {};
  const parsed = BudgetYamlSchema.safeParse(doc.budget);
  if (!parsed.success) {
    throw new Error("task budget config is invalid");
  }
  const stages: NonNullable<TaskBudgetCaps["stages"]> = {};
  for (const [stage, cap] of Object.entries(parsed.data.stages ?? {})) {
    stages[stage as PipelineStage] = {
      ...(cap.max_tokens !== undefined ? { maxTokens: cap.max_tokens } : {}),
      ...(cap.max_usd !== undefined ? { maxUsd: cap.max_usd } : {}),
    };
  }
  return {
    ...(parsed.data.max_tokens !== undefined ? { maxTokens: parsed.data.max_tokens } : {}),
    ...(parsed.data.max_usd !== undefined ? { maxUsd: parsed.data.max_usd } : {}),
    ...(Object.keys(stages).length > 0 ? { stages } : {}),
  };
}

/** Env overrides YAML. Missing both sides use the documented defaults. Invalid numbers throw. */
export function loadTaskBudgetCaps(env: NodeJS.ProcessEnv, workflowYaml?: string): TaskBudgetCaps {
  const fromYaml = capsFromYaml(workflowYaml);
  const maxTokens =
    readOptionalNumber(env, "OPTIO_TASK_MAX_TOKENS") ??
    fromYaml.maxTokens ??
    DEFAULT_TASK_MAX_TOKENS;
  const maxUsd =
    readOptionalNumber(env, "OPTIO_TASK_MAX_USD") ?? fromYaml.maxUsd ?? DEFAULT_TASK_MAX_USD;
  if (maxTokens < 0 || maxUsd < 0) {
    throw new Error("task budget caps must be >= 0");
  }
  return {
    maxTokens,
    maxUsd,
    ...(fromYaml.stages ? { stages: fromYaml.stages } : {}),
  };
}

export function explainOverCap(
  caps: TaskBudgetCaps,
  snapshot: TaskUsageSnapshot,
  stage?: PipelineStage,
): BudgetFailReason | undefined {
  if (tokensOf(snapshot.task) > caps.maxTokens) return "token_cap";
  if (snapshot.task.costUsd > caps.maxUsd) return "usd_cap";
  const names = stage ? [stage] : PIPELINE_STAGES;
  for (const name of names) {
    const stageCaps = caps.stages?.[name];
    const stageUsage = snapshot.stages[name] ?? ZERO;
    if (stageCaps?.maxTokens !== undefined && tokensOf(stageUsage) > stageCaps.maxTokens) {
      return "stage_token_cap";
    }
    if (stageCaps?.maxUsd !== undefined && stageUsage.costUsd > stageCaps.maxUsd) {
      return "stage_usd_cap";
    }
  }
  return undefined;
}

function needsTokens(caps: TaskBudgetCaps, stage: PipelineStage): boolean {
  return caps.maxTokens !== undefined || caps.stages?.[stage]?.maxTokens !== undefined;
}

function needsUsd(caps: TaskBudgetCaps, stage: PipelineStage): boolean {
  return caps.maxUsd !== undefined || caps.stages?.[stage]?.maxUsd !== undefined;
}

function finiteNonNegative(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Complete means every active cap dimension was reported. Omission is not zero. */
export function reportedUsage(
  caps: TaskBudgetCaps,
  stage: PipelineStage,
  usage: StageStepUsage | undefined,
): UsageTotals | undefined {
  const inputTokens = usage?.inputTokens;
  const outputTokens = usage?.outputTokens;
  const costUsd = usage?.costUsd;
  if (
    needsTokens(caps, stage) &&
    (!finiteNonNegative(inputTokens) || !finiteNonNegative(outputTokens))
  ) {
    return undefined;
  }
  if (needsUsd(caps, stage) && !finiteNonNegative(costUsd)) {
    return undefined;
  }
  return {
    inputTokens: finiteNonNegative(inputTokens) ? inputTokens : 0,
    outputTokens: finiteNonNegative(outputTokens) ? outputTokens : 0,
    costUsd: finiteNonNegative(costUsd) ? costUsd : 0,
  };
}

export class BudgetExceededError extends UnrecoverableError {
  readonly code = "BudgetExceeded" as const;
  readonly reason: BudgetFailReason;
  readonly taskId: string;
  readonly sessionId: string;
  readonly stage: PipelineStage;
  readonly step: string;
  readonly usage: UsageTotals;
  readonly caps: TaskBudgetCaps;

  constructor(args: {
    reason: BudgetFailReason;
    taskId: string;
    sessionId: string;
    stage: PipelineStage;
    step: string;
    usage: UsageTotals;
    caps: TaskBudgetCaps;
  }) {
    super(
      `BudgetExceeded: ${args.reason} task=${args.taskId} stage=${args.stage} step=${args.step} tokens=${tokensOf(args.usage)} maxTokens=${args.caps.maxTokens} usd=${args.usage.costUsd} maxUsd=${args.caps.maxUsd}`,
    );
    this.name = "BudgetExceededError";
    this.reason = args.reason;
    this.taskId = args.taskId;
    this.sessionId = args.sessionId;
    this.stage = args.stage;
    this.step = args.step;
    this.usage = args.usage;
    this.caps = args.caps;
  }
}

export function formatBudgetLog(
  status: TaskBudgetStatus & { stage?: PipelineStage; step?: string },
): string {
  return JSON.stringify({
    msg: "task_budget",
    taskId: status.taskId,
    sessionId: status.sessionId,
    ...(status.stage ? { stage: status.stage } : {}),
    ...(status.step ? { step: status.step } : {}),
    inputTokens: status.usage.inputTokens,
    outputTokens: status.usage.outputTokens,
    tokens: status.usage.tokens,
    maxTokens: status.caps.maxTokens,
    costUsd: status.usage.costUsd,
    maxUsd: status.caps.maxUsd,
    exceeded: status.exceeded,
    ...(status.reason ? { reason: status.reason } : {}),
  });
}

function publicCaps(caps: TaskBudgetCaps): TaskBudgetStatus["caps"] {
  const stages: NonNullable<TaskBudgetStatus["caps"]["stages"]> = {};
  for (const [stage, cap] of Object.entries(caps.stages ?? {})) {
    stages[stage as PipelineStage] = {
      ...(cap?.maxTokens !== undefined ? { maxTokens: cap.maxTokens } : {}),
      ...(cap?.maxUsd !== undefined ? { maxUsd: cap.maxUsd } : {}),
    };
  }
  return {
    maxTokens: caps.maxTokens,
    maxUsd: caps.maxUsd,
    ...(Object.keys(stages).length > 0 ? { stages } : {}),
  };
}

function publicUsage(snapshot: TaskUsageSnapshot): TaskBudgetStatus["usage"] {
  const stages: TaskBudgetStatus["usage"]["stages"] = {};
  for (const [stage, totals] of Object.entries(snapshot.stages)) {
    if (!totals) continue;
    stages[stage as PipelineStage] = {
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      tokens: tokensOf(totals),
      costUsd: totals.costUsd,
    };
  }
  return {
    inputTokens: snapshot.task.inputTokens,
    outputTokens: snapshot.task.outputTokens,
    tokens: tokensOf(snapshot.task),
    costUsd: snapshot.task.costUsd,
    stages,
  };
}

export async function readTaskBudgetStatus(
  binding: BudgetBinding,
  identity: { taskId: string; sessionId: string },
  stage?: PipelineStage,
): Promise<TaskBudgetStatus> {
  const snapshot = await binding.usage.get(identity.taskId, identity.sessionId);
  const reason = explainOverCap(binding.caps, snapshot, stage);
  const exceeded = reason !== undefined;
  return {
    ok: true,
    taskId: identity.taskId,
    sessionId: identity.sessionId,
    caps: publicCaps(binding.caps),
    usage: publicUsage(snapshot),
    exceeded,
    ...(reason ? { reason } : {}),
  };
}

function logStatus(
  binding: BudgetBinding,
  status: TaskBudgetStatus,
  stage: PipelineStage,
  step: string,
): void {
  const line = formatBudgetLog({ ...status, stage, step });
  if (binding.log) binding.log(line);
  else console.log(line);
}

export async function assertBudgetBeforeRun(
  binding: BudgetBinding,
  ctx: { taskId: string; sessionId: string; stage: PipelineStage; step: string },
): Promise<void> {
  const snapshot = await binding.usage.get(ctx.taskId, ctx.sessionId);
  const reason = explainOverCap(binding.caps, snapshot, ctx.stage);
  const status = await readTaskBudgetStatus(binding, ctx, ctx.stage);
  logStatus(binding, status, ctx.stage, ctx.step);
  if (!reason) return;
  throw new BudgetExceededError({
    reason,
    taskId: ctx.taskId,
    sessionId: ctx.sessionId,
    stage: ctx.stage,
    step: ctx.step,
    usage: snapshot.task,
    caps: binding.caps,
  });
}

export async function accountBudgetAfterRun(
  binding: BudgetBinding,
  ctx: { taskId: string; sessionId: string; stage: PipelineStage; step: string },
  usage: StageStepUsage | undefined,
): Promise<void> {
  const delta = reportedUsage(binding.caps, ctx.stage, usage);
  if (!delta) {
    const snapshot = await binding.usage.get(ctx.taskId, ctx.sessionId);
    const status = await readTaskBudgetStatus(binding, ctx, ctx.stage);
    logStatus(
      binding,
      { ...status, exceeded: true, reason: "usage_unreported" },
      ctx.stage,
      ctx.step,
    );
    throw new BudgetExceededError({
      reason: "usage_unreported",
      taskId: ctx.taskId,
      sessionId: ctx.sessionId,
      stage: ctx.stage,
      step: ctx.step,
      usage: snapshot.task,
      caps: binding.caps,
    });
  }
  const updatedAt = (binding.now ?? (() => new Date()))().toISOString();
  const snapshot = await binding.usage.add(ctx.taskId, ctx.sessionId, ctx.stage, delta, updatedAt);
  const reason = explainOverCap(binding.caps, snapshot, ctx.stage);
  const status = await readTaskBudgetStatus(binding, ctx, ctx.stage);
  logStatus(binding, status, ctx.stage, ctx.step);
  if (!reason) return;
  throw new BudgetExceededError({
    reason,
    taskId: ctx.taskId,
    sessionId: ctx.sessionId,
    stage: ctx.stage,
    step: ctx.step,
    usage: snapshot.task,
    caps: binding.caps,
  });
}

const USAGE_MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../state/migrations/003_task_usage.sql",
);

export function loadTaskUsageDdl(): string {
  return readFileSync(USAGE_MIGRATION, "utf8");
}

export const UPSERT_TASK_USAGE_SQL = `INSERT INTO task_usage (
  task_id, session_id, stage, input_tokens, output_tokens, cost_usd, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (task_id, session_id, stage)
DO UPDATE SET
  input_tokens = task_usage.input_tokens + EXCLUDED.input_tokens,
  output_tokens = task_usage.output_tokens + EXCLUDED.output_tokens,
  cost_usd = task_usage.cost_usd + EXCLUDED.cost_usd,
  updated_at = EXCLUDED.updated_at`;

export const SELECT_TASK_USAGE_SQL = `SELECT stage, input_tokens, output_tokens, cost_usd
FROM task_usage
WHERE task_id = $1 AND session_id = $2`;

function readCount(value: unknown): number {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("invalid task usage counter");
  }
  return parsed;
}

function isStage(value: string): value is PipelineStage {
  return (PIPELINE_STAGES as readonly string[]).includes(value);
}

export function createSqlUsageStore(db: SqlExecutor): UsageStore {
  return {
    async get(taskId, sessionId) {
      const result = await db.query(SELECT_TASK_USAGE_SQL, [taskId, sessionId]);
      const stages = new Map<PipelineStage, UsageTotals>();
      for (const row of result.rows) {
        const stage = row.stage;
        if (typeof stage !== "string" || !isStage(stage)) {
          throw new Error(`invalid task usage stage: ${String(stage)}`);
        }
        stages.set(stage, {
          inputTokens: readCount(row.input_tokens),
          outputTokens: readCount(row.output_tokens),
          costUsd: readCount(row.cost_usd),
        });
      }
      return snapshotOf(stages);
    },
    async add(taskId, sessionId, stage, delta, updatedAt) {
      await db.query(UPSERT_TASK_USAGE_SQL, [
        taskId,
        sessionId,
        stage,
        delta.inputTokens,
        delta.outputTokens,
        delta.costUsd,
        updatedAt,
      ]);
      return this.get(taskId, sessionId);
    },
  };
}

export async function createPgUsageStore(
  connectionString: string,
): Promise<UsageStore & { close(): Promise<void> }> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString });
  const db: SqlExecutor = {
    async query(sql, params) {
      const result = await pool.query(sql, params as unknown[] | undefined);
      return { rows: result.rows as Record<string, unknown>[] };
    },
  };
  await db.query(loadTaskUsageDdl());
  const store = createSqlUsageStore(db);
  return {
    get: (taskId, sessionId) => store.get(taskId, sessionId),
    add: (taskId, sessionId, stage, delta, updatedAt) =>
      store.add(taskId, sessionId, stage, delta, updatedAt),
    close: () => pool.end(),
  };
}
