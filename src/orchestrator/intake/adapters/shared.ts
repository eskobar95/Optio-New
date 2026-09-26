/**
 * Shared adapter result. Responses never include the signing secret or the signature.
 */
import { timingSafeEqual } from "node:crypto";
import type { BotIntakeCreated } from "../event.js";

export type IntakeAdapterResult =
  | { action: "enqueue"; status: 200 | 202; intake: BotIntakeCreated }
  | { action: "respond"; status: number; body: Record<string, unknown> };

export function headerValue(signatureHeader: string | string[] | undefined): string {
  if (Array.isArray(signatureHeader)) return signatureHeader[0]?.trim() ?? "";
  return signatureHeader?.trim() ?? "";
}

export function signaturesMatch(expected: string, presented: string): boolean {
  const expectedBuf = Buffer.from(expected);
  const presentedBuf = Buffer.from(presented);
  if (presentedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(presentedBuf, expectedBuf);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
