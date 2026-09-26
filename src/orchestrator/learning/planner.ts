/**
 * Read model for the planner. Recommendations are text only.
 * Review-gate verdicts and skill allow-lists are not changed here.
 */
import type { LearningRecord } from "./store.js";

export function formatPlannerLearnings(records: readonly LearningRecord[]): string {
  if (records.length === 0) return "";
  const lines = ["Known failure patterns (cross-session). These do not change production gates."];
  for (const record of records) {
    const skills = record.skillIds.length > 0 ? record.skillIds.join(",") : "none";
    lines.push(
      `- [${record.status}] field=${record.field} step=${record.stepId} error=${record.errorClass} hits=${record.hitCount} skills=${skills}`,
    );
    const proposal = record.recommendation ?? proposalLine(record.proposalBody);
    if (proposal) {
      lines.push(`  Recommendation (planner only, not applied to gates): ${proposal}`);
    }
  }
  return lines.join("\n");
}

export function skillAdjustmentFromLearnings(records: readonly LearningRecord[]): {
  deprioritizeIds: string[];
} {
  const ids = new Set<string>();
  for (const record of records) {
    if (record.status !== "proposed") continue;
    for (const id of record.skillIds) ids.add(id);
  }
  return { deprioritizeIds: [...ids].sort() };
}

function proposalLine(body: string | null): string | undefined {
  if (!body) return undefined;
  const section = body.split("### Proposal")[1];
  if (!section) return undefined;
  const line = section
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.length > 0);
  return line;
}
