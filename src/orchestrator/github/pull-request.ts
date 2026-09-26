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
    }),
  });
  if (created.status === 422) {
    const existing = await findOpenPullRequest(input);
    if (existing) return existing;
  }
  if (!created.ok) {
    throw await requestError(created, input.token, "pull request");
  }
  return readPullRequest(created, input.token);
}

export async function readCommitStatus(input: {
  token: string;
  owner: string;
  repo: string;
  sha: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const endpoint = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/commits/${encodeURIComponent(input.sha)}/status`;
  const response = await githubFetch(fetchImpl, endpoint, input.token, { method: "GET" });
  if (!response.ok) {
    throw await requestError(response, input.token, "commit status");
  }
  const payload = (await response.json()) as unknown;
  const state = record(payload)?.state;
  return typeof state === "string" && state.length > 0 ? state : "pending";
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

async function findOpenPullRequest(
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
