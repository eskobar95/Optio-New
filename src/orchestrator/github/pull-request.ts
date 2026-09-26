/**
 * GitHub pull requests for the ready/open_pr step.
 * Token and repo come from the caller. This module does not read process.env.
 */
import { redactSecrets } from "../../security/redact.js";
export class GithubRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "GithubRequestError";
    this.status = status;
  }
}

export interface GithubRepoRef {
  owner: string;
  repo: string;
}

export interface PullRequestRef {
  url: string;
  number: number;
}

export interface OpenPullRequestInput {
  token: string;
  owner: string;
  repo: string;
  title: string;
  head: string;
  base: string;
  body: string;
  /** When true, GitHub opens the pull request as a draft. */
  draft?: boolean;
  fetchImpl?: typeof fetch;
}

const REPO_SPEC = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function parseGithubRepo(spec: string): GithubRepoRef {
  const trimmed = spec.trim();
  if (!REPO_SPEC.test(trimmed)) {
    throw new Error("OPTIO_NEW_GITHUB_REPO must be owner/repo");
  }
  const slash = trimmed.indexOf("/");
  return { owner: trimmed.slice(0, slash), repo: trimmed.slice(slash + 1) };
}

/** owner/repo from a catalog clone URL. Non-GitHub remotes return undefined. */
export function githubRepoFromCloneUrl(cloneUrl: string): GithubRepoRef | undefined {
  const trimmed = cloneUrl
    .trim()
    .replace(/\.git\/?$/, "")
    .replace(/\/$/, "");
  let path = "";
  if (trimmed.startsWith("git@github.com:")) {
    path = trimmed.slice("git@github.com:".length);
  } else {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return undefined;
    }
    if (url.hostname !== "github.com") return undefined;
    path = url.pathname.replace(/^\//, "");
  }
  const slash = path.indexOf("/");
  if (slash <= 0 || slash !== path.lastIndexOf("/")) return undefined;
  const owner = path.slice(0, slash);
  const repo = path.slice(slash + 1);
  if (!REPO_SPEC.test(`${owner}/${repo}`)) return undefined;
  return { owner, repo };
}

export async function openGithubPullRequest(input: OpenPullRequestInput): Promise<PullRequestRef> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const endpoint = pullsUrl(input.owner, input.repo);
  const created = await githubFetch(fetchImpl, endpoint, input.token, {
    method: "POST",
    body: JSON.stringify({
      title: input.title,
      head: input.head,
      base: input.base,
      body: input.body,
      ...(input.draft ? { draft: true } : {}),
    }),
  });
  if (created.status === 422) {
    const existing = await findOpenGithubPullRequest(input);
    if (existing) return existing;
  }
  if (!created.ok) {
    throw await requestError(created, input.token, "pull request");
  }
  return readPullRequest(created, input.token);
}

export interface CommitStatusReport {
  state: string;
  failedChecks: string[];
}

export async function readCommitStatus(input: {
  token: string;
  owner: string;
  repo: string;
  sha: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  return (await readCommitStatusReport(input)).state;
}

/**
 * Combined CI signal for ready / `record_ci_wait`.
 * Commit statuses and check runs both count. GitHub's combined status stays
 * `pending` with zero contexts on Actions-only repos; green check runs are
 * still success. `neutral` and `skipped` conclusions do not fail CI.
 */
export async function readCommitStatusReport(input: {
  token: string;
  owner: string;
  repo: string;
  sha: string;
  fetchImpl?: typeof fetch;
}): Promise<CommitStatusReport> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const endpoint = commitResourceUrl(input, "status");
  const response = await githubFetch(fetchImpl, endpoint, input.token, { method: "GET" });
  if (!response.ok) {
    throw await requestError(response, input.token, "commit status");
  }
  const payload = (await response.json()) as unknown;
  const checks = await listLatestCheckRuns(input, fetchImpl);
  return combineCiSignals([
    ...signalsFromCommitStatus(record(payload)),
    ...signalsFromCheckRuns(checks),
  ]);
}

const PASSING_CHECK_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const CHECK_RUN_PAGE_CAP = 10;

type CiOutcome = "success" | "pending" | "failure";

interface CiSignal {
  name: string;
  outcome: CiOutcome;
}

async function listLatestCheckRuns(
  input: {
    token: string;
    owner: string;
    repo: string;
    sha: string;
  },
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>[]> {
  const collected: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (let page = 1; page <= CHECK_RUN_PAGE_CAP; page += 1) {
    const endpoint = `${commitResourceUrl(input, "check-runs")}?filter=latest&per_page=100&page=${page}`;
    const response = await githubFetch(fetchImpl, endpoint, input.token, { method: "GET" });
    if (!response.ok) {
      throw await requestError(response, input.token, "check runs");
    }
    const row = record(await response.json());
    total = typeof row?.total_count === "number" ? row.total_count : collected.length;
    const batch = Array.isArray(row?.check_runs) ? row.check_runs : [];
    for (const item of batch) {
      const check = record(item);
      if (!check) continue;
      const id = typeof check.id === "number" ? String(check.id) : "";
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      collected.push(check);
    }
    if (batch.length === 0 || collected.length >= total) return collected;
  }
  if (collected.length < total) {
    throw new GithubRequestError(200, "github check runs exceeded page cap");
  }
  return collected;
}

function signalsFromCommitStatus(row: Record<string, unknown> | undefined): CiSignal[] {
  const rollup = typeof row?.state === "string" ? row.state : "";
  const statuses = row?.statuses;
  if (!Array.isArray(statuses)) return signalsFromStatusRollup(rollup, false);
  if (statuses.length === 0) return signalsFromStatusRollup(rollup, true);
  const signals: CiSignal[] = [];
  for (const item of statuses) {
    const status = record(item);
    if (!status) continue;
    const context = typeof status.context === "string" ? status.context.trim() : "";
    const state = typeof status.state === "string" ? status.state : "";
    signals.push({ name: context, outcome: statusOutcome(state) });
  }
  return signals;
}

/** Zero contexts and a pending rollup are GitHub's empty default, not an in-progress check. */
function signalsFromStatusRollup(rollup: string, emptyContexts: boolean): CiSignal[] {
  if (rollup === "success") return [{ name: "", outcome: "success" }];
  if (rollup === "failure" || rollup === "error") return [{ name: "", outcome: "failure" }];
  if (emptyContexts) return [];
  return [{ name: "", outcome: "pending" }];
}

function statusOutcome(state: string): CiOutcome {
  if (state === "success") return "success";
  if (state === "pending" || state.length === 0) return "pending";
  return "failure";
}

function signalsFromCheckRuns(checks: readonly Record<string, unknown>[]): CiSignal[] {
  return checks.map((check) => {
    const name = typeof check.name === "string" ? check.name.trim() : "";
    const status = typeof check.status === "string" ? check.status : "";
    const conclusion = typeof check.conclusion === "string" ? check.conclusion : "";
    return { name, outcome: checkOutcome(status, conclusion) };
  });
}

function checkOutcome(status: string, conclusion: string): CiOutcome {
  if (status !== "completed") return "pending";
  if (PASSING_CHECK_CONCLUSIONS.has(conclusion)) return "success";
  if (conclusion.length === 0) return "pending";
  return "failure";
}

function combineCiSignals(signals: readonly CiSignal[]): CommitStatusReport {
  const failedChecks: string[] = [];
  let pending = false;
  let sawSuccess = false;
  let sawFailure = false;
  for (const signal of signals) {
    if (signal.outcome === "failure") {
      sawFailure = true;
      if (signal.name) failedChecks.push(signal.name);
      continue;
    }
    if (signal.outcome === "pending") {
      pending = true;
      continue;
    }
    sawSuccess = true;
  }
  if (sawFailure) return { state: "failure", failedChecks: [...new Set(failedChecks)] };
  if (pending || !sawSuccess) return { state: "pending", failedChecks: [] };
  return { state: "success", failedChecks: [] };
}

function commitResourceUrl(
  input: { owner: string; repo: string; sha: string },
  resource: "status" | "check-runs",
): string {
  return `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/commits/${encodeURIComponent(input.sha)}/${resource}`;
}

export async function mergeGithubPullRequest(input: {
  token: string;
  owner: string;
  repo: string;
  number: number;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const endpoint = `${pullsUrl(input.owner, input.repo)}/${input.number}/merge`;
  const response = await githubFetch(fetchImpl, endpoint, input.token, {
    method: "PUT",
    body: JSON.stringify({ merge_method: "merge" }),
  });
  if (!response.ok) {
    throw await requestError(response, input.token, "merge");
  }
  const payload = (await response.json()) as unknown;
  if (record(payload)?.merged !== true) {
    throw new GithubRequestError(response.status, "github merge did not complete");
  }
}

export async function markGithubPullRequestReady(input: {
  token: string;
  owner: string;
  repo: string;
  number: number;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const endpoint = `${pullsUrl(input.owner, input.repo)}/${input.number}`;
  const response = await githubFetch(fetchImpl, endpoint, input.token, {
    method: "PATCH",
    body: JSON.stringify({ draft: false }),
  });
  if (!response.ok) {
    throw await requestError(response, input.token, "undraft");
  }
}

export interface GithubReviewNote {
  login: string;
  state: string;
  body: string;
}

export async function listGithubPullRequestReviews(input: {
  token: string;
  owner: string;
  repo: string;
  number: number;
  fetchImpl?: typeof fetch;
}): Promise<GithubReviewNote[]> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const endpoint = `${pullsUrl(input.owner, input.repo)}/${input.number}/reviews`;
  const response = await githubFetch(fetchImpl, endpoint, input.token, { method: "GET" });
  if (!response.ok) {
    throw await requestError(response, input.token, "reviews");
  }
  const payload = (await response.json()) as unknown;
  if (!Array.isArray(payload)) return [];
  const notes: GithubReviewNote[] = [];
  for (const item of payload) {
    const row = record(item);
    if (!row) continue;
    const login = record(row.user)?.login;
    if (typeof login !== "string" || login.length === 0) continue;
    notes.push({
      login,
      state: typeof row.state === "string" ? row.state : "",
      body: typeof row.body === "string" ? row.body : "",
    });
  }
  return notes;
}

/**
 * Asks existing reviewers to look again and posts the feedback on the pull request.
 * Does not change `draft`.
 */
export async function reRequestGithubPullRequestReview(input: {
  token: string;
  owner: string;
  repo: string;
  number: number;
  reviewers: readonly string[];
  comment: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const reviewers = [...new Set(input.reviewers.map((login) => login.trim()).filter(Boolean))];
  if (reviewers.length > 0) {
    const endpoint = `${pullsUrl(input.owner, input.repo)}/${input.number}/requested_reviewers`;
    const response = await githubFetch(fetchImpl, endpoint, input.token, {
      method: "POST",
      body: JSON.stringify({ reviewers }),
    });
    if (!response.ok && response.status !== 422) {
      throw await requestError(response, input.token, "re-request review");
    }
  }
  const reviewEndpoint = `${pullsUrl(input.owner, input.repo)}/${input.number}/reviews`;
  const reviewed = await githubFetch(fetchImpl, reviewEndpoint, input.token, {
    method: "POST",
    body: JSON.stringify({ body: input.comment, event: "COMMENT" }),
  });
  if (!reviewed.ok && reviewed.status !== 422) {
    throw await requestError(reviewed, input.token, "pull request review comment");
  }
  const commentEndpoint = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues/${input.number}/comments`;
  const commented = await githubFetch(fetchImpl, commentEndpoint, input.token, {
    method: "POST",
    body: JSON.stringify({ body: input.comment }),
  });
  if (!commented.ok) {
    throw await requestError(commented, input.token, "pull request comment");
  }
}

export async function githubPullRequestApproved(input: {
  token: string;
  owner: string;
  repo: string;
  number: number;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const endpoint = `${pullsUrl(input.owner, input.repo)}/${input.number}/reviews`;
  const response = await githubFetch(fetchImpl, endpoint, input.token, { method: "GET" });
  if (!response.ok) {
    throw await requestError(response, input.token, "reviews");
  }
  const payload = (await response.json()) as unknown;
  if (!Array.isArray(payload)) return false;
  return payload.some((item) => record(item)?.state === "APPROVED");
}

export async function findOpenGithubPullRequest(
  input: OpenPullRequestInput,
): Promise<PullRequestRef | undefined> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const head = `${input.owner}:${input.head}`;
  const endpoint = `${pullsUrl(input.owner, input.repo)}?head=${encodeURIComponent(head)}&state=open`;
  const response = await githubFetch(fetchImpl, endpoint, input.token, { method: "GET" });
  if (!response.ok) {
    throw await requestError(response, input.token, "pull request lookup");
  }
  const payload = (await response.json()) as unknown;
  if (!Array.isArray(payload)) return undefined;
  for (const item of payload) {
    const row = record(item);
    const ref = record(row?.head)?.ref;
    if (ref === input.head) {
      const parsed = pullFromRecord(row);
      if (parsed) return parsed;
    }
  }
  return undefined;
}

function pullsUrl(owner: string, repo: string): string {
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "optio-new-orchestrator",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function githubFetch(
  fetchImpl: typeof fetch,
  endpoint: string,
  token: string,
  init: { method: string; body?: string },
): Promise<Response> {
  return fetchImpl(endpoint, {
    method: init.method,
    headers: githubHeaders(token),
    body: init.body,
  });
}

async function requestError(
  response: Response,
  token: string,
  action: string,
): Promise<GithubRequestError> {
  const text = (await response.text()).slice(0, 300);
  return new GithubRequestError(
    response.status,
    redact(`github ${action} failed: ${response.status} ${text}`, [token]),
  );
}

async function readPullRequest(response: Response, token: string): Promise<PullRequestRef> {
  const payload = (await response.json()) as unknown;
  const parsed = pullFromRecord(record(payload));
  if (!parsed) {
    throw new GithubRequestError(
      response.status,
      redact("github pull request response missing html_url", [token]),
    );
  }
  return parsed;
}

function pullFromRecord(row: Record<string, unknown> | undefined): PullRequestRef | undefined {
  if (!row) return undefined;
  const url = row.html_url;
  const number = row.number;
  if (typeof url !== "string" || url.length === 0 || typeof number !== "number") return undefined;
  return { url, number };
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function redact(text: string, secrets: readonly string[]): string {
  let out = redactSecrets(text);
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join("[redacted]");
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) out = out.split(encoded).join("[redacted]");
  }
  return out;
}
