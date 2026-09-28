/**
 * Tiny Zod contracts for Cursor CLI mid-run soft tools (ENG-27).
 * Keep schemas small — token floor for MCP tools/list + tools/call.
 */

import { z } from "zod";

/** Mid-run decision kinds Cursor may ask about. */
export const JevMidrunKindSchema = z.enum([
  "continue_vs_escalate",
  "next_file",
  "tests_green_enough",
]);
export type JevMidrunKind = z.infer<typeof JevMidrunKindSchema>;

const SHORT = z.string().max(500);

/** Compact state only — no extras (token floor). */
export const JevMidrunStateSchema = z
  .object({
    task_id: SHORT.optional(),
    step_id: SHORT.optional(),
    file_path: SHORT.optional(),
    summary: SHORT.optional(),
  })
  .strict();
export type JevMidrunState = z.infer<typeof JevMidrunStateSchema>;

export const DEFAULT_MIDRUN_MIN_CONFIDENCE = 0.7;
export const DEFAULT_MIDRUN_TIMEOUT_MS = 30_000;

export const JevMidrunInputSchema = z
  .object({
    kind: JevMidrunKindSchema,
    state: JevMidrunStateSchema.default({}),
    timeoutMs: z.number().int().positive().max(120_000).optional(),
    minConfidence: z.number().min(0).max(1).optional(),
  })
  .strict();
export type JevMidrunInput = z.infer<typeof JevMidrunInputSchema>;

export const JevEvaluateRecommendationSchema = z.enum([
  "continue",
  "escalate",
  "pick_file",
  "run_tests",
  "defer",
]);
export type JevEvaluateRecommendation = z.infer<typeof JevEvaluateRecommendationSchema>;

export const JevEvaluateAnswerSchema = z
  .object({
    recommendation: JevEvaluateRecommendationSchema,
    confidence: z.number().min(0).max(1),
    note: z.string().max(200).optional(),
  })
  .strict();
export type JevEvaluateAnswer = z.infer<typeof JevEvaluateAnswerSchema>;

export const JevDecideActionSchema = z.enum([
  "continue",
  "escalate",
  "pick_file",
  "run_tests",
  "defer",
]);
export type JevDecideAction = z.infer<typeof JevDecideActionSchema>;

/** Actions that can appear on a `decided` outcome (not escalate/defer). */
export type JevDecideResolvedAction = Exclude<JevDecideAction, "escalate" | "defer">;

export const JevDecideAnswerSchema = z
  .object({
    action: JevDecideActionSchema,
    confidence: z.number().min(0).max(1),
    file_path: z.string().max(500).optional(),
    note: z.string().max(200).optional(),
  })
  .strict();
export type JevDecideAnswer = z.infer<typeof JevDecideAnswerSchema>;

export type JevMidrunPassthroughReason =
  "timeout" | "http" | "network" | "invalid_url" | "invalid_body" | "low_confidence" | "undecided";

export type JevEvaluateOutcome =
  | {
      kind: "evaluated";
      recommendation: JevEvaluateRecommendation;
      confidence: number;
      note?: string;
    }
  | {
      kind: "passthrough";
      reason: JevMidrunPassthroughReason;
      confidence?: number;
      status?: number;
      message?: string;
    };

export type JevDecideOutcome =
  | {
      kind: "decided";
      action: JevDecideResolvedAction;
      confidence: number;
      file_path?: string;
      note?: string;
    }
  | {
      kind: "escalate";
      action: "escalate";
      confidence: number;
      note?: string;
    }
  | {
      kind: "passthrough";
      reason: JevMidrunPassthroughReason;
      confidence?: number;
      status?: number;
      message?: string;
    };

/** Minimal JSON Schema fragments for MCP tools/list (token floor). */
export const JEV_EVALUATE_INPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  properties: {
    kind: {
      type: "string",
      enum: ["continue_vs_escalate", "next_file", "tests_green_enough"],
    },
    state: {
      type: "object",
      additionalProperties: false,
      properties: {
        task_id: { type: "string", maxLength: 500 },
        step_id: { type: "string", maxLength: 500 },
        file_path: { type: "string", maxLength: 500 },
        summary: { type: "string", maxLength: 500 },
      },
    },
    timeoutMs: { type: "integer", minimum: 1, maximum: 120000 },
    minConfidence: { type: "number", minimum: 0, maximum: 1 },
  },
} as const;

export const JEV_DECIDE_INPUT_JSON_SCHEMA = JEV_EVALUATE_INPUT_JSON_SCHEMA;
