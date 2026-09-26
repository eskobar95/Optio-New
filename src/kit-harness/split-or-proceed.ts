/**
 * Heuristic task split. No Jev call in v0.
 * Split when the description already lists 3+ items, a known signal is set,
 * or file/step estimates exceed the thresholds (defaults: 8 files, 5 steps).
 */
import type { SplitDecision, SplitInput, SuggestedSubtask } from "./types.js";

const DEFAULT_MAX_FILES = 8;
const DEFAULT_MAX_STEPS = 5;
const MAX_SUBTASKS = 4;

const SIGNAL_SUBTASKS: Record<string, SuggestedSubtask> = {
  multi_package: {
    title: "Split by package",
    rationale: "Each package gets its own step so a failure stays local.",
  },
  schema_and_ui: {
    title: "Separate schema changes from UI",
    rationale: "Schema and UI review independently.",
  },
  cross_cutting: {
    title: "Separate the cross-cutting change",
    rationale: "Cross-cutting edits do not share a step with feature work.",
  },
};

function bulletLines(description: string | undefined): string[] {
  if (!description) return [];
  return description
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^([-*]|\d+[.)])\s+\S/.test(line))
    .map((line) => line.replace(/^([-*]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
}

function genericSubtasks(title: string | undefined): SuggestedSubtask[] {
  const label = title?.trim() || "this task";
  return [
    {
      title: `Narrow acceptance for ${label}`,
      rationale: "Write the pass condition before editing.",
    },
    {
      title: `Implement the smallest slice of ${label}`,
      rationale: "One vertical path, then stop.",
    },
    {
      title: `Add tests for ${label}`,
      rationale: "Lock the slice before widening scope.",
    },
  ];
}

function knownSignals(signals: string[] | undefined): SuggestedSubtask[] {
  const seen = new Set<string>();
  const subtasks: SuggestedSubtask[] = [];
  for (const signal of signals ?? []) {
    const key = signal.trim().toLowerCase();
    const subtask = SIGNAL_SUBTASKS[key];
    if (!subtask || seen.has(key)) continue;
    seen.add(key);
    subtasks.push(subtask);
  }
  return subtasks.slice(0, MAX_SUBTASKS);
}

export function splitOrProceed(input: SplitInput): SplitDecision {
  const bullets = bulletLines(input.description);
  if (bullets.length >= 3) {
    return {
      action: "split",
      reason: "bullet_list",
      subtasks: bullets.slice(0, MAX_SUBTASKS).map((title) => ({
        title,
        rationale: "Listed as its own part of the task.",
      })),
    };
  }

  const fromSignals = knownSignals(input.signals);
  if (fromSignals.length > 0) {
    return { action: "split", reason: "signal", subtasks: fromSignals };
  }

  const maxFiles = input.max_files_before_split ?? DEFAULT_MAX_FILES;
  const files = input.estimated_files ?? 0;
  if (files > maxFiles) {
    return {
      action: "split",
      reason: "estimated_files",
      subtasks: genericSubtasks(input.title),
    };
  }

  const maxSteps = input.max_steps_before_split ?? DEFAULT_MAX_STEPS;
  const steps = input.estimated_steps ?? 0;
  if (steps > maxSteps) {
    return {
      action: "split",
      reason: "estimated_steps",
      subtasks: genericSubtasks(input.title),
    };
  }

  return { action: "proceed", reason: "within_limits" };
}
