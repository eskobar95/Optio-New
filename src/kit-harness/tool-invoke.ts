/**
 * Wraps a tool call with the gate and a short timeout.
 * A hung runner is cancelled with reason tool_timeout. Callers should keep timeout_ms small.
 */
import { decideTool } from "./tool-gate.js";
import type { ToolContext } from "./types.js";

export interface ToolInvokeResult {
  status: "ok" | "cancel" | "deny";
  reason: string;
  tool: string;
}

export async function invokeGuardedTool(input: {
  tool: string;
  context?: ToolContext;
  timeout_ms: number;
  run: (signal: AbortSignal) => Promise<unknown>;
}): Promise<ToolInvokeResult> {
  const gate = await decideTool(input.tool, input.context ?? {});
  if (gate.decision === "deny") {
    return { status: "deny", reason: gate.reason, tool: input.tool };
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ToolInvokeResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({ status: "cancel", reason: "tool_timeout", tool: input.tool });
      controller.abort();
    }, input.timeout_ms);
  });
  const work = input.run(controller.signal).then(
    () => ({ status: "ok" as const, reason: "completed", tool: input.tool }),
    () => ({ status: "cancel" as const, reason: "tool_failed", tool: input.tool }),
  );

  try {
    const result = await Promise.race([work, timeout]);
    if (result.reason === "tool_timeout") {
      console.log(
        JSON.stringify({
          service: "kit-harness",
          event: "tool_timeout",
          tool: input.tool,
          reason: "tool_timeout",
          timeout_ms: input.timeout_ms,
        }),
      );
    }
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
