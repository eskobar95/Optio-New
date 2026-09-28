/**
 * Optio ↔ Flue HTTP contract (ENG-26).
 *
 * Flue agent shape (future real loop — stub does not execute these):
 *   useModel — model selection for Flue's own loop
 *   useSandbox — local() first (v1); no Docker sandbox
 *   useTool — cursor-agent invoke (thin stub / ENG-21 later)
 *   useMcpConnection — Linear / GitHub connectors as needed
 *
 * Internal phases (document only; stub skips the loop):
 *   planner → builder specialists → TDD skill (default, Jev-waivable) → CI green
 *
 * Session continuity:
 *   implement session is durable (Flue conversation + usePersistentState /
 *   durableConversationId). Review is a separate session that posts structured
 *   feedback to the implement session id. Jev routes minimal fix vs re-run vs human.
 *
 * Usage v1: usageEvents[] in the JSON response. SSE streaming is a later cut.
 */

import { z } from "zod";

/** Sandbox mode for Flue v1 — local() only. */
export const FlueSandboxModeSchema = z.literal("local");
export type FlueSandboxMode = z.infer<typeof FlueSandboxModeSchema>;

export const FlueUsageEventSchema = z
  .object({
    kind: z.enum(["token", "cost"]),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    cachedTokens: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
    modelId: z.string().min(1).optional(),
    provider: z.string().min(1).default("flue"),
    at: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export type FlueUsageEvent = z.infer<typeof FlueUsageEventSchema>;

/**
 * POST /dispatch — Optio asks Flue to bind a task to a durable session.
 * Does not run the agent loop; call POST /start next.
 */
export const FlueDispatchRequestSchema = z
  .object({
    taskId: z.string().min(1),
    worktreeId: z.string().min(1),
    workflowId: z.string().min(1),
    stepId: z.string().min(1),
    agentId: z.string().min(1),
    workspaceRef: z.string().min(1),
    /** Soft link to flue.sessions / optio workspace when known. */
    optioWorkspaceId: z.string().uuid().optional(),
    /** Resume an existing durable Flue conversation when set. */
    durableConversationId: z.string().min(1).optional(),
    sandboxMode: FlueSandboxModeSchema.default("local"),
    prompt: z.string().min(1),
    instructions: z.string().optional(),
    allowedTools: z.array(z.string().min(1)).default([]),
    modelId: z.string().min(1).optional(),
  })
  .strict();

export type FlueDispatchRequest = z.infer<typeof FlueDispatchRequestSchema>;

export const FlueDispatchResponseSchema = z
  .object({
    sessionId: z.string().uuid(),
    durableConversationId: z.string().min(1),
    status: z.enum(["accepted", "resumed"]),
  })
  .strict();

export type FlueDispatchResponse = z.infer<typeof FlueDispatchResponseSchema>;

/**
 * POST /start — Optio tells Flue to run (or stub-complete) the session.
 * Returns branch + optional PR URL + usage events for Optio's usage schema.
 */
export const FlueStartRequestSchema = z
  .object({
    sessionId: z.string().uuid(),
    durableConversationId: z.string().min(1),
    taskId: z.string().min(1),
  })
  .strict();

export type FlueStartRequest = z.infer<typeof FlueStartRequestSchema>;

export const FlueStartResponseSchema = z
  .object({
    sessionId: z.string().uuid(),
    branch: z.string().min(1),
    prUrl: z.string().url().optional(),
    usageEvents: z.array(FlueUsageEventSchema).default([]),
    status: z.enum(["succeeded", "failed"]),
    errorClass: z.string().min(1).optional(),
    logs: z.string().optional(),
  })
  .strict();

export type FlueStartResponse = z.infer<typeof FlueStartResponseSchema>;

export const FlueHealthResponseSchema = z
  .object({
    ok: z.literal(true),
    service: z.literal("flue"),
  })
  .strict();

export type FlueHealthResponse = z.infer<typeof FlueHealthResponseSchema>;
