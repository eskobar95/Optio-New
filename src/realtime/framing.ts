/**
 * JSON wire framing for realtime control + live events (ENG-40).
 */
import {
  ClientFrameSchema,
  OutboundFrameSchema,
  type ClientFrame,
  type OutboundFrame,
} from "./types.js";

export class FrameDecodeError extends Error {
  readonly code = "invalid_frame";
  constructor(message: string) {
    super(message);
    this.name = "FrameDecodeError";
  }
}

export function encodeFrame(frame: OutboundFrame | ClientFrame): string {
  return JSON.stringify(frame);
}

export function decodeClientFrame(raw: string): ClientFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new FrameDecodeError("frame is not valid JSON");
  }
  const result = ClientFrameSchema.safeParse(parsed);
  if (!result.success) {
    throw new FrameDecodeError(result.error.issues[0]?.message ?? "invalid client frame");
  }
  return result.data;
}

export function decodeOutboundFrame(raw: string): OutboundFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new FrameDecodeError("frame is not valid JSON");
  }
  const result = OutboundFrameSchema.safeParse(parsed);
  if (!result.success) {
    throw new FrameDecodeError(result.error.issues[0]?.message ?? "invalid outbound frame");
  }
  return result.data as OutboundFrame;
}
