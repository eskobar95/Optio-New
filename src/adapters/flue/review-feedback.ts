/**
 * Review → implement session feedback stub (ENG-36).
 * Review posts structured feedback into the durable implement Flue binding.
 * No new Flue HTTP endpoint — accumulated context is injected on next dispatch.
 */

import { z } from "zod";

import {
  FLUE_IMPLEMENT_BINDING_STAGE,
  type FlueReviewFeedbackItem,
  type FlueSessionBinding,
  type FlueSessionBindingStore,
} from "./session-binding.js";

export const FlueReviewFeedbackSchema = z
  .object({
    source: z.literal("review"),
    summary: z.string().min(1),
    mustFix: z.array(z.string().min(1)).default([]),
    verdict: z.string().min(1).optional(),
    files: z.array(z.string().min(1)).optional(),
    at: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export type FlueReviewFeedback = z.infer<typeof FlueReviewFeedbackSchema>;

/**
 * Append structured review feedback onto the implement binding for `taskId`.
 * If the implement session is not yet bound, creates a pending shell with empty
 * session ids so feedback is not lost before the first accept.
 */
export function appendReviewFeedback(
  store: FlueSessionBindingStore,
  taskId: string,
  payload: FlueReviewFeedback,
): FlueSessionBinding {
  const parsed = FlueReviewFeedbackSchema.parse(payload);
  const item: FlueReviewFeedbackItem = {
    source: "review",
    summary: parsed.summary,
    mustFix: [...parsed.mustFix],
    ...(parsed.verdict !== undefined ? { verdict: parsed.verdict } : {}),
    ...(parsed.files !== undefined ? { files: [...parsed.files] } : {}),
    ...(parsed.at !== undefined ? { at: parsed.at } : {}),
  };

  const prior = store.get(taskId, FLUE_IMPLEMENT_BINDING_STAGE);
  return store.put({
    taskId,
    stage: FLUE_IMPLEMENT_BINDING_STAGE,
    flueSessionId: prior?.flueSessionId ?? "",
    durableConversationId: prior?.durableConversationId ?? "",
    feedback: [...(prior?.feedback ?? []), item],
  });
}

/** Format accumulated feedback for injection into the next Flue dispatch. */
export function formatAccumulatedFeedback(feedback: readonly FlueReviewFeedbackItem[]): string {
  if (feedback.length === 0) return "";

  const blocks = feedback.map((item, index) => {
    const lines = [
      `### Review feedback ${index + 1}`,
      ...(item.verdict ? [`Verdict: ${item.verdict}`] : []),
      `Summary: ${item.summary}`,
    ];
    if (item.mustFix.length > 0) {
      lines.push("Must fix:");
      for (const fix of item.mustFix) lines.push(`- ${fix}`);
    }
    if (item.files && item.files.length > 0) {
      lines.push(`Files: ${item.files.join(", ")}`);
    }
    if (item.at) lines.push(`At: ${item.at}`);
    return lines.join("\n");
  });

  return ["## Accumulated review feedback (same Flue session)", "", ...blocks].join("\n");
}
