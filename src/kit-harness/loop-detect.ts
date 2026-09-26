/**
 * Loop detection over a caller-supplied window (stateless).
 * Identical failure fingerprints and consecutive same-tool failures.
 */
import { normalizeToken, type LoopDetectInput, type LoopDetectResult } from "./types.js";

function pack(partial: Omit<LoopDetectResult, "halt">): LoopDetectResult {
  return { ...partial, halt: partial.suggestion === "stop" };
}

const DEFAULT_THRESHOLD = 3;
const MAX_EVENTS = 200;

function clampThreshold(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_THRESHOLD;
  return Math.max(2, Math.min(50, Math.floor(value)));
}

export function detectLoop(input: LoopDetectInput): LoopDetectResult {
  const events = input.events.slice(-MAX_EVENTS);
  const failureThreshold = clampThreshold(input.threshold);
  const thrashThreshold = clampThreshold(input.tool_thrash_threshold);

  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.outcome !== "fail") continue;
    const fingerprint = event.fingerprint.trim();
    if (!fingerprint) continue;
    counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1);
  }

  let topFingerprint = "";
  let topCount = 0;
  for (const [fingerprint, count] of counts) {
    if (count > topCount) {
      topFingerprint = fingerprint;
      topCount = count;
    }
  }

  if (topCount >= failureThreshold) {
    const stop = topCount >= failureThreshold + 2;
    return pack({
      loop_detected: true,
      kind: "repeated_failure",
      suggestion: stop ? "stop" : "replan",
      fingerprint: topFingerprint,
      count: topCount,
      reason: stop ? "failure_fingerprint_stop" : "failure_fingerprint_replan",
    });
  }

  let streakTool = "";
  let streak = 0;
  let bestTool = "";
  let best = 0;
  for (const event of events) {
    const tool = event.tool ? normalizeToken(event.tool) : "";
    if (event.outcome === "fail" && tool) {
      streak = tool === streakTool ? streak + 1 : 1;
      streakTool = tool;
      if (streak > best) {
        best = streak;
        bestTool = tool;
      }
    } else {
      streak = 0;
      streakTool = "";
    }
  }

  if (best >= thrashThreshold) {
    return pack({
      loop_detected: true,
      kind: "tool_thrash",
      suggestion: "stop",
      tool: bestTool,
      count: best,
      reason: "tool_thrash_stop",
    });
  }

  return pack({ loop_detected: false, reason: "no_loop" });
}
