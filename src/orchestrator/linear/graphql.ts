/**
 * Linear GraphQL POST. Callers must pass assertLinearWrite first.
 * The API key is redacted from errors.
 */
import { redactSecrets } from "../../security/redact.js";

export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

export async function postLinearGraphql(input: {
  apiKey: string;
  query: string;
  variables: Record<string, string>;
  fetchImpl?: typeof fetch;
}): Promise<Record<string, unknown>> {
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new Error("Linear API key is not configured");
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: apiKey,
    },
    body: JSON.stringify({ query: input.query, variables: input.variables }),
  });
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    payload = undefined;
  }
  const record = asRecord(payload);
  const errors = record?.errors;
  if (!response.ok || (Array.isArray(errors) && errors.length > 0) || !record) {
    throw new Error(redact(response.status, text, apiKey));
  }
  return record;
}

function redact(status: number, body: string, apiKey: string): string {
  let message = redactSecrets(`Linear GraphQL failed: ${status} ${body.slice(0, 300)}`);
  if (apiKey) message = message.split(apiKey).join("[redacted]");
  return message;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
