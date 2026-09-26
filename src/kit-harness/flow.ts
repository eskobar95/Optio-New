/**
 * Stubbed task → worktree → implementation → review → PR chain.
 * No Cursor, Codex, git, or network. Used by the CI smoke scenario.
 */
import { checkCompletion } from "./completion-check.js";
import { routeModel } from "./model-routing.js";
import { decideTool } from "./tool-gate.js";

export const FLOW_STAGES = ["intake", "worktree", "implementation", "review", "pr"] as const;

export type FlowStage = (typeof FLOW_STAGES)[number];

export interface FlowSuccess {
  ok: true;
  stages: FlowStage[];
  task_id: string;
  worktree_path: string;
  pr: { branch: string; ready: true };
}

export interface FlowFailure {
  ok: false;
  reason: string;
  stages: FlowStage[];
}

export type FlowResult = FlowSuccess | FlowFailure;

export async function runStubbedFlow(input: {
  task_id: string;
  title: string;
}): Promise<FlowResult> {
  const taskId = input.task_id.trim();
  const title = input.title.trim();
  const stages: FlowStage[] = [];
  if (!taskId || !title) return { ok: false, reason: "invalid_intake", stages };

  stages.push("intake");
  const worktreePath = `/optio/worktrees/${taskId}`;
  stages.push("worktree");

  const route = await routeModel({
    task_id: taskId,
    coding_backend: "cursor",
    cursor_quota_remaining: 1,
  });
  if (route.choice === "deny") return { ok: false, reason: route.reason, stages };

  const gate = await decideTool("read_file", { path: "src/app.ts", agent_id: taskId });
  if (gate.decision === "deny") return { ok: false, reason: gate.reason, stages };
  stages.push("implementation");

  const review = await checkCompletion({
    tests_green: true,
    typecheck_green: true,
    lint_green: true,
    diff_present: true,
    ci_status: "success",
  });
  if (review.verdict !== "pass") return { ok: false, reason: review.reason, stages };
  stages.push("review");
  stages.push("pr");

  return {
    ok: true,
    stages,
    task_id: taskId,
    worktree_path: worktreePath,
    pr: { branch: `task/${taskId}`, ready: true },
  };
}
