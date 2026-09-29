import { describe, expect, it } from "vitest";
import {
  channelKind,
  ChannelParseError,
  channelMatches,
  parseChannelId,
  parseChannelIds,
  sessionChannel,
  systemStatusChannel,
  workspaceChannel,
} from "../src/realtime/channels.js";

describe("realtime channels", () => {
  it("parses session, workspace, and system channels", () => {
    expect(parseChannelId("session:abc")).toBe("session:abc");
    expect(parseChannelId("workspace:ws-1")).toBe("workspace:ws-1");
    expect(parseChannelId("system:status")).toBe("system:status");
    expect(channelKind("session:abc")).toBe("session");
    expect(channelKind("workspace:ws-1")).toBe("workspace");
    expect(channelKind(systemStatusChannel())).toBe("system");
  });

  it("rejects malformed and unknown channels", () => {
    expect(() => parseChannelId("session:")).toThrow(ChannelParseError);
    expect(() => parseChannelId("team:eng")).toThrow(ChannelParseError);
    expect(() => parseChannelId("system:metrics")).toThrow(ChannelParseError);
  });

  it("dedupes while preserving order", () => {
    expect(parseChannelIds(["session:a", "session:a", "workspace:w"])).toEqual([
      "session:a",
      "workspace:w",
    ]);
  });

  it("builds channels from raw ids", () => {
    expect(sessionChannel("s-1")).toBe("session:s-1");
    expect(workspaceChannel("w-1")).toBe("workspace:w-1");
  });

  it("matches only the exact channel", () => {
    expect(channelMatches("session:a", "session:a")).toBe(true);
    expect(channelMatches("session:a", "session:b")).toBe(false);
    expect(channelMatches("system:status", "session:a")).toBe(false);
  });
});
