/**
 * Optio-side Flue session binding (ENG-36).
 * Maps taskId + stage → durable Flue session so pause/approval/retry resume
 * the same conversation instead of cold-starting.
 *
 * Durable implement sessions use stage `"implement"`. Review is a separate
 * Flue session that posts structured feedback into the implement binding.
 */

export const FLUE_IMPLEMENT_BINDING_STAGE = "implement" as const;

/** Binding stage key. Durable implement sessions use {@link FLUE_IMPLEMENT_BINDING_STAGE}. */
export type FlueBindingStage = string;

/** Soft cap so accumulated review feedback cannot unbounded-bloat dispatch instructions. */
export const FLUE_FEEDBACK_MAX_ITEMS = 20;

/** Who appended feedback onto the durable implement binding. */
export type FlueFeedbackSource = "review" | "gate_retry" | "gate_send_back";

/** Structured feedback accumulated on the implement binding (review + workflow gates). */
export interface FlueReviewFeedbackItem {
  source: FlueFeedbackSource;
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

let defaultSessionBindingStore: FlueSessionBindingStore | undefined;

/**
 * Process-scoped default store so `createFlueAdapter()` / `createCodingAgent("flue")`
 * recreates share continuity within one process. Inject a durable store for multi-process.
 */
export function getDefaultFlueSessionBindingStore(): FlueSessionBindingStore {
  defaultSessionBindingStore ??= new InMemoryFlueSessionBindingStore();
  return defaultSessionBindingStore;
}

/** Reset the process default (tests only). */
export function resetDefaultFlueSessionBindingStore(): void {
  defaultSessionBindingStore = undefined;
}

/** Keep the newest {@link FLUE_FEEDBACK_MAX_ITEMS} feedback entries. */
export function capFeedback(
  feedback: readonly FlueReviewFeedbackItem[],
  max = FLUE_FEEDBACK_MAX_ITEMS,
): FlueReviewFeedbackItem[] {
  if (feedback.length <= max) return feedback.map(cloneFeedback);
  return feedback.slice(feedback.length - max).map(cloneFeedback);
}

function cloneFeedback(item: FlueReviewFeedbackItem): FlueReviewFeedbackItem {
  return {
    source: item.source,
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
