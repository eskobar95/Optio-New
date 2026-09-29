import { describe, expect, it } from "vitest";
import {
  decodeClientFrame,
  decodeOutboundFrame,
  encodeFrame,
  FrameDecodeError,
} from "../src/realtime/framing.js";
import type { LiveEvent } from "../src/realtime/types.js";

const tokenEvent: LiveEvent = {
  type: "run.token",
  seq: 3,
  channel: "session:s-1",
  ts: 1_700_000_000_000,
  payload: { runId: "r-1", sessionId: "s-1", text: "hello" },
};

describe("realtime framing", () => {
  it("round-trips a live event through encode/decode", () => {
    const decoded = decodeOutboundFrame(encodeFrame(tokenEvent));
    expect(decoded).toEqual(tokenEvent);
  });

  it("decodes each client control frame variant", () => {
    expect(decodeClientFrame('{"type":"ping","ts":1}')).toEqual({ type: "ping", ts: 1 });
    expect(
      decodeClientFrame('{"type":"subscribe","channels":["session:s-1"],"lastSeq":4}'),
    ).toEqual({
      type: "subscribe",
      channels: ["session:s-1"],
      lastSeq: 4,
    });
    expect(decodeClientFrame('{"type":"auth","token":"abc"}')).toEqual({
      type: "auth",
      token: "abc",
    });
  });

  it("rejects non-JSON and unknown frame types", () => {
    expect(() => decodeClientFrame("not json")).toThrow(FrameDecodeError);
    expect(() => decodeClientFrame('{"type":"nope"}')).toThrow(FrameDecodeError);
    expect(() => decodeOutboundFrame('{"type":"nope"}')).toThrow(FrameDecodeError);
  });

  it("rejects an outbound event with an unknown channel id", () => {
    const bad = { ...tokenEvent, channel: "team:eng" };
    expect(() => decodeOutboundFrame(JSON.stringify(bad))).toThrow(FrameDecodeError);
  });

  it("rejects subscribe with empty channels", () => {
    expect(() => decodeClientFrame('{"type":"subscribe","channels":[]}')).toThrow(FrameDecodeError);
  });
});
