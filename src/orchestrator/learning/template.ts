/**
 * Meta-issue body for `meta/self-improve` (SPEC §10.2).
 * The text proposes a budget change. Applying it is a human step.
 */

export interface MetaIssueDraft {
  title: string;
  body: string;
  labels: readonly ["meta/self-improve"];
  fingerprint: string;
}

export function renderMetaIssue(input: {
  fingerprint: string;
  workflowId: string;
  stepId: string;
  skillIds: readonly string[];
  specialistIds: readonly string[];
  errorClass: string;
  field: string;
  hitCount: number;
  threshold: number;
  windowDays: number;
  sampleTaskIds: readonly string[];
}): MetaIssueDraft {
  const skills =
    input.skillIds.length > 0 ? input.skillIds.map((id) => `\`${id}\``).join(", ") : "(none)";
  const specialists = input.specialistIds.length > 0 ? input.specialistIds.join(", ") : "(none)";
  const proposal =
    input.skillIds.length > 0
      ? input.skillIds
          .map(
            (id) =>
              `Propose removing \`${id}\` from the \`${input.stepId}\` budget for field \`${input.field}\`.`,
          )
          .join("\n")
      : `Propose a human review of the \`${input.stepId}\` budget for field \`${input.field}\` after repeated \`${input.errorClass}\`.`;
  const samples =
    input.sampleTaskIds.length > 0
      ? input.sampleTaskIds.map((id) => `- ${id}`).join("\n")
      : "- (none)";

  const body = [
    "## meta/self-improve",
    "",
    `Fingerprint: \`${input.fingerprint}\``,
    `Field: \`${input.field}\``,
    `Workflow: \`${input.workflowId}\``,
    `Step: \`${input.stepId}\``,
    `Error class: \`${input.errorClass}\``,
    `Hits: ${input.hitCount} within ${input.windowDays} days (threshold ${input.threshold})`,
    "",
    "### Pattern",
    `Skills: ${skills}`,
    `Specialists: ${specialists}`,
    "",
    "### Sample tasks",
    samples,
    "",
    "### Proposal",
    proposal,
    "",
    "This worker does not change production gates, workflow YAML, skill files, or always-on rules. A human applies the budget change after reviewing this meta-issue.",
    "",
  ].join("\n");

  return {
    title: `[meta/self-improve] ${input.errorClass} on ${input.field} (${input.stepId})`,
    body,
    labels: ["meta/self-improve"],
    fingerprint: input.fingerprint,
  };
}
