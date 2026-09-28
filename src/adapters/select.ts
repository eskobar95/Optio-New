/**
 * Hop 1 backend pick (SPEC §13.2, §14.4).
 * Step `coding_backend`, else the harness default, else fail closed.
 * Shared prompts are not edited when the backend flips.
 */

import { createCodexAdapter } from "./codex/index.js";
import type { CodingAgent } from "./coding-agent.js";
import { createCursorAdapter } from "./cursor/index.js";
import { createFlueAdapter, type FlueAdapterDeps } from "./flue/index.js";
import type { CodingAgentDeps } from "./runtime.js";

export type CodingBackendId = "cursor" | "codex" | "flue";

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

function blankToNull(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function isCodingBackendId(value: string): value is CodingBackendId {
  return value === "cursor" || value === "codex" || value === "flue";
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

export function createCodingAgent(
  id: CodingBackendId,
  deps: CodingAgentDeps & FlueAdapterDeps = {},
): CodingAgent {
  if (id === "cursor") return createCursorAdapter(deps);
  if (id === "flue") return createFlueAdapter(deps);
  return createCodexAdapter(deps);
}
