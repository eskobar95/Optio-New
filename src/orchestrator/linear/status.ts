/**
 * issueUpdate of stateId, and comments other than the Phase 1 `queued` ack.
 * Does not create, delete, or archive issues, and does not create workflow states.
 */
import { redactSecrets } from "../../security/redact.js";
import { assertLinearWrite } from "./policy.js";
import { postLinearGraphql } from "./graphql.js";
import { LINEAR_STATUS, normalizeStatus } from "./workflow.js";

const COMMENT_CREATE = `mutation CommentCreate($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
  }
}`;

const STATES_QUERY = `query IssueStates($id: String!) {
  issue(id: $id) {
    team {
      states {
        nodes { id name }
      }
    }
  }
}`;

const ISSUE_UPDATE = `mutation IssueUpdate($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) {
    success
  }
}`;

export class LinearStatusMissingError extends Error {
  readonly status: string;

  constructor(status: string) {
    super(`Linear status ${status} is not on this issue's team`);
    this.name = "LinearStatusMissingError";
    this.status = status;
  }
}

export async function commentOnIssue(input: {
  apiKey: string;
  issueId: string;
  body: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  assertLinearWrite("commentCreate");
  const body = redactSecrets(input.body);
  const record = await postLinearGraphql({
    apiKey: input.apiKey,
    query: COMMENT_CREATE,
    variables: { issueId: input.issueId, body },
    fetchImpl: input.fetchImpl,
  });
  const created = asRecord(asRecord(record.data)?.commentCreate);
  if (created?.success !== true) {
    throw new Error("Linear commentCreate failed");
  }
}

export async function updateLinearIssueStateId(input: {
  apiKey: string;
  issueId: string;
  stateId: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  assertLinearWrite("issueUpdate", ["stateId"]);
  const record = await postLinearGraphql({
    apiKey: input.apiKey,
    query: ISSUE_UPDATE,
    variables: { id: input.issueId, stateId: input.stateId },
    fetchImpl: input.fetchImpl,
  });
  const updated = asRecord(asRecord(record.data)?.issueUpdate);
  if (updated?.success !== true) {
    throw new Error("Linear issueUpdate failed");
  }
}

export async function updateLinearIssueStatus(input: {
  apiKey: string;
  issueId: string;
  statusName: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const stateId = await findStateId(input);
  if (!stateId) throw new LinearStatusMissingError(input.statusName);
  await updateLinearIssueStateId({ ...input, stateId });
}

/** Needs Human when that column exists, otherwise In Progress. */
export async function escalationTargetStatus(input: {
  apiKey: string;
  issueId: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const states = await listStates(input);
  const preferred = states.find((state) => state.name === LINEAR_STATUS.needsHuman);
  if (preferred) return LINEAR_STATUS.needsHuman;
  return LINEAR_STATUS.inProgress;
}

async function findStateId(input: {
  apiKey: string;
  issueId: string;
  statusName: string;
  fetchImpl?: typeof fetch;
}): Promise<string | undefined> {
  const wanted = normalizeStatus(input.statusName);
  const states = await listStates(input);
  const exact = states.find((state) => normalizeStatus(state.name) === wanted);
  if (exact) return exact.id;
  if (wanted === LINEAR_STATUS.done) {
    return states.find((state) => state.name.trim().toLowerCase() === "completed")?.id;
  }
  return undefined;
}

async function listStates(input: {
  apiKey: string;
  issueId: string;
  fetchImpl?: typeof fetch;
}): Promise<{ id: string; name: string }[]> {
  const record = await postLinearGraphql({
    apiKey: input.apiKey,
    query: STATES_QUERY,
    variables: { id: input.issueId },
    fetchImpl: input.fetchImpl,
  });
  const issue = asRecord(asRecord(record.data)?.issue);
  const team = asRecord(issue?.team);
  const states = asRecord(team?.states);
  const nodes = states?.nodes;
  if (!Array.isArray(nodes)) return [];
  const listed: { id: string; name: string }[] = [];
  for (const node of nodes) {
    const row = asRecord(node);
    const id = row?.id;
    const name = row?.name;
    if (typeof id === "string" && typeof name === "string") listed.push({ id, name });
  }
  return listed;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
