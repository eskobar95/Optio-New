/**
 * Channel id parse / validate (ENG-40 multiplex).
 */
import {
  SYSTEM_CHANNEL_NAMES,
  type ChannelId,
  type ChannelKind,
  type SystemChannelName,
} from "./types.js";

const SESSION_RE = /^session:([A-Za-z0-9_.:-]{1,128})$/;
const WORKSPACE_RE = /^workspace:([A-Za-z0-9_.:-]{1,128})$/;
const SYSTEM_RE = /^system:([A-Za-z0-9_-]{1,64})$/;

export class ChannelParseError extends Error {
  readonly code = "invalid_channel";
  constructor(message: string) {
    super(message);
    this.name = "ChannelParseError";
  }
}

export function parseChannelId(raw: string): ChannelId {
  const session = SESSION_RE.exec(raw);
  if (session) return `session:${session[1]}` as ChannelId;

  const workspace = WORKSPACE_RE.exec(raw);
  if (workspace) return `workspace:${workspace[1]}` as ChannelId;

  const system = SYSTEM_RE.exec(raw);
  if (system) {
    const name = system[1];
    if (!(SYSTEM_CHANNEL_NAMES as readonly string[]).includes(name)) {
      throw new ChannelParseError(`unknown system channel: ${raw}`);
    }
    return `system:${name as SystemChannelName}`;
  }

  throw new ChannelParseError(`invalid channel id: ${raw}`);
}

export function parseChannelIds(raw: readonly string[]): ChannelId[] {
  const out: ChannelId[] = [];
  const seen = new Set<string>();
  for (const id of raw) {
    const parsed = parseChannelId(id);
    if (seen.has(parsed)) continue;
    seen.add(parsed);
    out.push(parsed);
  }
  return out;
}

export function channelKind(id: ChannelId): ChannelKind {
  if (id.startsWith("session:")) return "session";
  if (id.startsWith("workspace:")) return "workspace";
  return "system";
}

export function sessionChannel(sessionId: string): ChannelId {
  return parseChannelId(`session:${sessionId}`);
}

export function workspaceChannel(workspaceId: string): ChannelId {
  return parseChannelId(`workspace:${workspaceId}`);
}

export function systemStatusChannel(): ChannelId {
  return "system:status";
}

/** True when an event on `eventChannel` should reach a socket subscribed to `sub`. */
export function channelMatches(sub: ChannelId, eventChannel: ChannelId): boolean {
  if (sub === eventChannel) return true;
  // workspace subscription receives session events tagged with that workspace via fan-out routing;
  // exact match is the default — hub routes by explicit channel on each event.
  return false;
}
