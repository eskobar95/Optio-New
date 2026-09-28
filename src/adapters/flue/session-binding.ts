/**
 * Optio-side Flue session binding (ENG-36).
 * Maps taskId + stage → durable Flue session so pause/approval/retry resume
 * the same conversation instead of cold-starting.
 *
 * Durable implement sessions use stage `"implement"`. Review is a separate
 * Flue session that posts structured feedback into the implement binding.
 */

export const FLUE_IMPLEMENT_BINDING_STAGE = "implement" as const;

export type FlueBindingStage = typeof FLUE_IMPLEMENT_BINDING_STAGE | string;

/** Structured review feedback accumulated on the implement binding. */
export interface FlueReviewFeedbackItem {
  source: "review";
  summary: string;
  mustFix: string[];
  verdict?: string;
  files?: string[];
  at?: string;
}

export interface FlueSessionBinding {
  taskId: string;
  stage: FlueBindingStage;
  flueSessionId: string;
  durableConversationId: string;
  feedback: FlueReviewFeedbackItem[];
}

export interface FlueSessionBindingPut {
  taskId: string;
  stage: FlueBindingStage;
  flueSessionId: string;
  durableConversationId: string;
  /** When omitted, existing feedback is preserved on update. */
  feedback?: FlueReviewFeedbackItem[];
}

export interface FlueSessionBindingStore {
  get(taskId: string, stage: FlueBindingStage): FlueSessionBinding | undefined;
  put(binding: FlueSessionBindingPut): FlueSessionBinding;
  clear(taskId: string, stage: FlueBindingStage): void;
}

export function flueBindingKey(taskId: string, stage: FlueBindingStage): string {
  return `${taskId}::${stage}`;
}

export class InMemoryFlueSessionBindingStore implements FlueSessionBindingStore {
  private readonly rows = new Map<string, FlueSessionBinding>();

  get(taskId: string, stage: FlueBindingStage): FlueSessionBinding | undefined {
    const row = this.rows.get(flueBindingKey(taskId, stage));
    return row ? cloneBinding(row) : undefined;
  }

  put(binding: FlueSessionBindingPut): FlueSessionBinding {
    const key = flueBindingKey(binding.taskId, binding.stage);
    const prior = this.rows.get(key);
    const next: FlueSessionBinding = {
      taskId: binding.taskId,
      stage: binding.stage,
      flueSessionId: binding.flueSessionId,
      durableConversationId: binding.durableConversationId,
      feedback: binding.feedback
        ? binding.feedback.map(cloneFeedback)
        : (prior?.feedback.map(cloneFeedback) ?? []),
    };
    this.rows.set(key, next);
    return cloneBinding(next);
  }

  clear(taskId: string, stage: FlueBindingStage): void {
    this.rows.delete(flueBindingKey(taskId, stage));
  }
}

function cloneFeedback(item: FlueReviewFeedbackItem): FlueReviewFeedbackItem {
  return {
    source: "review",
    summary: item.summary,
    mustFix: [...item.mustFix],
    ...(item.verdict !== undefined ? { verdict: item.verdict } : {}),
    ...(item.files !== undefined ? { files: [...item.files] } : {}),
    ...(item.at !== undefined ? { at: item.at } : {}),
  };
}

function cloneBinding(binding: FlueSessionBinding): FlueSessionBinding {
  return {
    taskId: binding.taskId,
    stage: binding.stage,
    flueSessionId: binding.flueSessionId,
    durableConversationId: binding.durableConversationId,
    feedback: binding.feedback.map(cloneFeedback),
  };
}
