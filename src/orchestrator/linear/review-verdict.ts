/**
 * Hannes verdict and the compressed handoff the next implement pass reads.
 * Signal-up stays a separate Triage issue. This comment is in-task feedback.
 * Handoff shape: short fields, redacted tokens, no log dump.
 */

export class ReviewRejectedError extends Error {
  readonly sha: string;
  readonly feedback: string;

  constructor(sha: string, feedback: string) {
    super("hannes rejected the review");
    this.name = "ReviewRejectedError";
    this.sha = sha;
    this.feedback = feedback;
  }
}

export interface ReviewVerdict {
  verdict: "pass" | "fail";
  files: string[];
  standards: string;
  spec: string;
  slop: string;
  expected: string;
}

const VERDICT_LINE = /OPTIO_REVIEW_VERDICT\s+(pass|fail)\b/gi;
const FIELD_LINE = /^(Files|Standards|Spec|Slop|Expected):\s*(.*)$/i;

export function parseReviewVerdict(text: string): ReviewVerdict {
  const matches = [...text.matchAll(VERDICT_LINE)];
  const last = matches.at(-1);
  const verdict = last?.[1]?.toLowerCase() === "pass" ? "pass" : "fail";
  const after = last ? text.slice((last.index ?? 0) + last[0].length) : text;
  const fields = { files: "", standards: "", spec: "", slop: "", expected: "" };
  for (const line of after.split("\n")) {
    const field = FIELD_LINE.exec(line.trim());
    if (!field?.[1]) continue;
    const key = field[1].toLowerCase();
    const value = redactField(field[2] ?? "");
    if (key === "files") fields.files = value;
    else if (key === "standards") fields.standards = value;
    else if (key === "spec") fields.spec = value;
    else if (key === "slop") fields.slop = value;
    else if (key === "expected") fields.expected = value;
  }
  const files = fields.files
    .split(",")
    .map((file) => file.trim())
    .filter(Boolean)
    .slice(0, 8);
  return {
    verdict,
    files,
    standards: clip(fields.standards, 400),
    spec: clip(fields.spec, 400),
    slop: clip(fields.slop, 200),
    expected: clip(fields.expected || (verdict === "fail" ? "Fix the named files." : ""), 500),
  };
}

/** Linear / worktree handoff. One screen. The implement agent must not re-derive the review. */
export function hannesFeedbackComment(input: {
  verdict: ReviewVerdict;
  attempt: number;
  escalateAfter: number;
}): string {
  const files = input.verdict.files.length > 0 ? input.verdict.files.join(", ") : "(none named)";
  return [
    "[review]",
    "Verdict: fail",
    `Files: ${clip(files, 300)}`,
    `Standards: ${clip(input.verdict.standards || "unspecified", 400)}`,
    `Spec: ${clip(input.verdict.spec || "unspecified", 400)}`,
    `Slop: ${clip(input.verdict.slop || "none", 200)}`,
    `Expected: ${clip(input.verdict.expected || "Fix the named files.", 500)}`,
    "Scope: in-task fix only. Do not open a signal-up issue.",
    `Attempt: ${input.attempt}/${input.escalateAfter}`,
  ].join("\n");
}

function redactField(value: string): string {
  return value
    .replace(/ghp_[A-Za-z0-9]+/g, "[REDACTED]")
    .replace(/sk-[A-Za-z0-9]+/g, "[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
}

function clip(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 3)}...`;
}
