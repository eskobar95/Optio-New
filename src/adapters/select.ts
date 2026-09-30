/**
 * Hop 1 backend pick (SPEC §13.2, §14.4).
 * Step `coding_backend`, else the harness default, else fail closed.
 * Shared prompts are not edited when the backend flips.
 *
 * Optional Jev cascade (ENG-25 gate #1):
 * - `applyBackendCascade` — sync map of a gate outcome
 * - `resolveCodingBackendWithCascade` — async: run gate then map (opt-in; no Flue force)
 */

import {
  BackendCascadeTimeoutError,
  runBackendCascadeGate,
  type BackendCascadeConfig,
  type BackendCascadeOutcome,
  type BackendCascadeState,
  type CascadeModelTier,
} from "../../gateway/jev-router/gates/index.js";
import type { JevClient } from "../../gateway/jev-router/jev-client.js";
import { createCodexAdapter } from "./codex/index.js";
import type { CodingAgent } from "./coding-agent.js";
import { createCursorAdapter, type CursorAdapterDeps } from "./cursor/index.js";
import { createFlueAdapter, type FlueAdapterDeps } from "./flue/index.js";
import { createOptioRunAdapter, type OptioRunAdapterDeps } from "./optio-run/index.js";
import type { CodingAgentDeps } from "./runtime.js";

export type CodingBackendId = "cursor" | "codex" | "flue" | "optio-run";

export interface CodingBackendSelection {
  /** Workflow step `coding_backend`. Wins over the global default. */
  stepCodingBackend?: string | null;
  /** Global harness default when the step omits `coding_backend`. */
  defaultBackend?: string | null;
}

export type { CodingAgentDeps };

export class CodingBackendUndecidedError extends Error {
  readonly error_class = "coding_backend_undecided";

  constructor(message: string) {
    super(message);
    this.name = "CodingBackendUndecidedError";
  }
}

/** Result of applying an optional Jev backend_cascade gate. */
export type CascadeCodingDecision =
  | {
      kind: "backend";
      backend: CodingBackendId;
      source: "cascade" | "passthrough";
      modelTier?: CascadeModelTier;
      confidence?: number;
      label?: string;
    }
  | {
      kind: "escalate";
      reason: "needs_human";
      confidence: number;
    };

function blankToNull(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function isCodingBackendId(value: string): value is CodingBackendId {
  return value === "cursor" || value === "codex" || value === "flue" || value === "optio-run";
}

/** Resolve which CodingAgent runs. Never guesses a provider. */
export function resolveCodingBackend(selection: CodingBackendSelection): CodingBackendId {
  const chosen = blankToNull(selection.stepCodingBackend) ?? blankToNull(selection.defaultBackend);
  if (!chosen) {
    throw new CodingBackendUndecidedError(
      "coding_backend is unset; set the workflow step or the harness default",
    );
  }
  if (!isCodingBackendId(chosen)) {
    throw new CodingBackendUndecidedError(`coding_backend "${chosen}" is not a known adapter`);
  }
  return chosen;
}

/**
 * Map a cascade gate outcome onto flue | cursor | escalate, or fall back to
 * deterministic resolveCodingBackend on passthrough. Opt-in; never forces Flue.
 * Hard timeout (`kind: "error"`) throws `BackendCascadeTimeoutError`.
 */
export function applyBackendCascade(
  selection: CodingBackendSelection,
  outcome: BackendCascadeOutcome,
): CascadeCodingDecision {
  if (outcome.kind === "error") {
    throw new BackendCascadeTimeoutError(outcome.message);
  }
  if (outcome.kind === "escalate") {
    return {
      kind: "escalate",
      reason: "needs_human",
      confidence: outcome.confidence,
    };
  }
  if (outcome.kind === "decided") {
    return {
      kind: "backend",
      backend: outcome.target.backend,
      source: "cascade",
      confidence: outcome.confidence,
      label: outcome.label,
      ...(outcome.target.backend === "cursor" ? { modelTier: outcome.target.modelTier } : {}),
    };
  }
  return {
    kind: "backend",
    backend: resolveCodingBackend(selection),
    source: "passthrough",
  };
}

/**
 * Opt-in Hop-1 path: call Jev cascade gate, then map to coding backend / escalate.
 */
export async function resolveCodingBackendWithCascade(
  selection: CodingBackendSelection,
  input: {
    client: JevClient;
    state: BackendCascadeState;
    config?: Partial<BackendCascadeConfig>;
  },
): Promise<CascadeCodingDecision> {
  const outcome = await runBackendCascadeGate(input);
  return applyBackendCascade(selection, outcome);
}

export function createCodingAgent(
  id: CodingBackendId,
  deps: CodingAgentDeps & FlueAdapterDeps & CursorAdapterDeps & OptioRunAdapterDeps = {},
): CodingAgent {
  if (id === "cursor") return createCursorAdapter(deps);
  if (id === "flue") return createFlueAdapter(deps);
  if (id === "optio-run") return createOptioRunAdapter(deps);
  return createCodexAdapter(deps);
}
