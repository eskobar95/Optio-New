/**
 * Posts the intake ack on a Linear issue. The mutation is commentCreate
 * and the body is exactly `queued`. No other Linear write is issued here.
 */
import { redactSecrets } from "../../security/redact.js";
import { assertLinearWrite } from "./policy.js";

export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
export const LINEAR_QUEUED_COMMENT = "queued";

const COMMENT_CREATE = `mutation CommentCreate($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
  }
}`;

export async function commentQueuedOnIssue(input: {
  apiKey: string;
  issueId: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  assertLinearWrite("commentCreate");
  const apiKey = input.apiKey.trim();
  if (!apiKey) {
    throw new Error("Linear API key is not configured");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: apiKey,
    },
    body: JSON.stringify({
      query: COMMENT_CREATE,
      variables: { issueId: input.issueId, body: LINEAR_QUEUED_COMMENT },
    }),
  });
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    payload = undefined;
  }
  const record = asRecord(payload);
  const data = asRecord(record?.data);
  const created = asRecord(data?.commentCreate);
  const errors = record?.errors;
  const failed =
    !response.ok || created?.success !== true || (Array.isArray(errors) && errors.length > 0);
  if (failed) {
    throw new Error(redact(response.status, text, apiKey));
  }
}

function redact(status: number, body: string, apiKey: string): string {
  const clipped = body.slice(0, 300);
  let message = redactSecrets(`Linear commentCreate failed: ${status} ${clipped}`);
  if (apiKey) message = message.split(apiKey).join("[redacted]");
  return message;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
