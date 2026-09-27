/**
 * Review entry ("Hannes"): who to request, which specialists the diff needs,
 * and the issue-comment marker that makes a second run a no-op.
 * GitHub HTTP stays in the pull-request module. This file does not call it.
 */
import { OPTIO_REVIEW_COMMENT_MARKER } from "./workflow.js";

export const REVIEW_GITHUB_LOGINS_ENV = "OPTIO_REVIEW_GITHUB_LOGINS";

const SPECIALIST_ORDER = [
  "specialists/back-end",
  "specialists/database",
  "specialists/devops",
  "specialists/front-end",
] as const;

/**
 * Comma-separated GitHub logins. Blank requests nobody.
 * There is no default login: Hannes is this automation, not an account.
 */
export function readReviewGithubLogins(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const raw = env[REVIEW_GITHUB_LOGINS_ENV] ?? "";
  const seen = new Set<string>();
  const logins: string[] = [];
  for (const part of raw.split(",")) {
    const login = part.trim();
    if (!login || seen.has(login)) continue;
    seen.add(login);
    logins.push(login);
  }
  return logins;
}

export function optioReviewMarker(sha: string): string {
  return `${OPTIO_REVIEW_COMMENT_MARKER} sha:${sha.trim()} -->`;
}

export function optioReviewPosted(bodies: readonly string[], sha: string): boolean {
  const marker = optioReviewMarker(sha);
  return bodies.some((body) => body.includes(marker));
}

/** Specialists whose responsibility matches the diff. Order is stable. */
export function reviewSpecialistsForPaths(paths: readonly string[]): string[] {
  const hits = new Set<string>();
  for (const raw of paths) {
    const file = raw.trim().replaceAll("\\", "/").toLowerCase();
    if (!file || file === "/dev/null") continue;
    if (isDatabasePath(file)) hits.add("specialists/database");
    if (isFrontendPath(file)) hits.add("specialists/front-end");
    if (isDevopsPath(file)) hits.add("specialists/devops");
    if (isBackendPath(file)) hits.add("specialists/back-end");
  }
  return SPECIALIST_ORDER.filter((id) => hits.has(id));
}

export function formatOptioReviewComment(input: {
  sha: string;
  reviewers: readonly string[];
  specialists: readonly string[];
  body: string;
}): string {
  const findings = input.body.trim() || "Review completed with no written findings.";
  return [
    optioReviewMarker(input.sha),
    "[optio-review]",
    `Head: ${input.sha.trim()}`,
    `Reviewer logins: ${input.reviewers.length > 0 ? input.reviewers.join(", ") : "(none configured)"}`,
    `Specialists: ${input.specialists.length > 0 ? input.specialists.join(", ") : "(none for this diff)"}`,
    "Skill: skills/code-review (Standards, Spec, Slop)",
    "",
    findings.slice(0, 12_000),
  ].join("\n");
}

function isDatabasePath(file: string): boolean {
  return (
    file.endsWith(".sql") ||
    /(^|\/)(migrations?|database|schema)(\/|$)/.test(file) ||
    /(^|\/)db(\/|$)/.test(file)
  );
}

function isFrontendPath(file: string): boolean {
  return (
    /\.(tsx|jsx|vue|css|scss|svelte)$/.test(file) ||
    /(^|\/)(apps\/web|components|frontend|front-end)\//.test(file)
  );
}

function isDevopsPath(file: string): boolean {
  return (
    /(^|\/)\.github\//.test(file) ||
    /(^|\/)(deploy|docker|infra|k8s|charts)\//.test(file) ||
    /(^|\/)dockerfile$/.test(file) ||
    /(^|\/)caddyfile$/.test(file) ||
    /(^|\/)docker-compose.*\.ya?ml$/.test(file)
  );
}

function isBackendPath(file: string): boolean {
  if (/\.(tsx|jsx)$/.test(file)) return false;
  return /\.(ts|js|mjs|cjs|py|go|rs|java)$/.test(file);
}
