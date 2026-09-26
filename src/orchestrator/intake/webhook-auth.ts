/**
 * HMAC for the public intake webhook. POST /intake on loopback does not use this.
 * The secret is OPTIO_NEW_INTAKE_WEBHOOK_SECRET. A blank secret fails closed.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const INTAKE_WEBHOOK_PATH = "/webhooks/intake";
export const INTAKE_WEBHOOK_SIGNATURE_HEADER = "x-optio-signature";

const SIGNATURE_PREFIX = "sha256=";

export function signIntakeWebhookBody(secret: string, body: Buffer): string {
  const hex = createHmac("sha256", secret).update(body).digest("hex");
  return `${SIGNATURE_PREFIX}${hex}`;
}

export interface IntakeWebhookAuthFailure {
  ok: false;
  status: 401 | 503;
  error: "invalid_signature" | "webhook_auth_unconfigured";
  message: string;
}

function headerValue(signatureHeader: string | string[] | undefined): string {
  if (Array.isArray(signatureHeader)) return signatureHeader[0]?.trim() ?? "";
  return signatureHeader?.trim() ?? "";
}

/** Constant-time check of `X-Optio-Signature: sha256=<hex>` over the raw body. */
export function authorizeIntakeWebhook(
  secret: string | undefined,
  body: Buffer,
  signatureHeader: string | string[] | undefined,
): { ok: true } | IntakeWebhookAuthFailure {
  const trimmed = secret?.trim() ?? "";
  if (!trimmed) {
    return {
      ok: false,
      status: 503,
      error: "webhook_auth_unconfigured",
      message: "Intake webhook secret is not configured",
    };
  }

  const expected = signIntakeWebhookBody(trimmed, body);
  const presented = headerValue(signatureHeader);
  const expectedBuf = Buffer.from(expected);
  const presentedBuf = Buffer.from(presented);
  if (presentedBuf.length !== expectedBuf.length || !timingSafeEqual(presentedBuf, expectedBuf)) {
    return {
      ok: false,
      status: 401,
      error: "invalid_signature",
      message: "Intake webhook signature is invalid",
    };
  }
  return { ok: true };
}
