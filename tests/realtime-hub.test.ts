import { describe, expect, it, vi } from "vitest";
import { decodeOutboundFrame } from "../src/realtime/framing.js";
import { RealtimeConnection, RealtimeHub, type RealtimeSocket } from "../src/realtime/hub.js";
import { StaticTokenAuth } from "../src/realtime/auth.js";
import { InMemorySnapshotStore } from "../src/realtime/snapshot.js";
import type { ChannelId, LiveEvent } from "../src/realtime/types.js";

class FakeSocket implements RealtimeSocket {
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
}

const SESSION_A = "session:s-1" as ChannelId;
const SESSION_B = "session:s-2" as ChannelId;

function tokenEvent(seq: number, sessionId: string): LiveEvent {
  return {
    type: "run.token",
    seq,
    channel: `session:${sessionId}` as ChannelId,
    ts: seq,
    payload: { runId: `r-${seq}`, sessionId, text: `t${seq}` },
  };
}

function statusEvent(seq: number, sessionId: string): LiveEvent {
  return {
    type: "run.status",
    seq,
    channel: `session:${sessionId}` as ChannelId,
    ts: seq,
    payload: { runId: `r-${seq}`, sessionId, status: "running" },
  };
}

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("RealtimeHub multiplex", () => {
  it("delivers events only to sockets subscribed to that channel", () => {
    const hub = new RealtimeHub();
    const socketA = new FakeSocket();
    const socketB = new FakeSocket();
    const connA = hub.attach(socketA);
    const connB = hub.attach(socketB);

    connA.handleMessage(JSON.stringify({ type: "subscribe", channels: [SESSION_A] }));
    connB.handleMessage(JSON.stringify({ type: "subscribe", channels: [SESSION_B] }));

    hub.publish(tokenEvent(1, "s-1"));

    const typesA = socketA.sent.map((s) => decodeOutboundFrame(s).type);
    const typesB = socketB.sent.map((s) => decodeOutboundFrame(s).type);
    expect(typesA).toContain("run.token");
    expect(typesB).not.toContain("run.token");
  });

  it("acks subscribe, sends snapshot, and routes matching events", () => {
    const hub = new RealtimeHub();
    const socket = new FakeSocket();
    const conn = hub.attach(socket);

    conn.handleMessage(JSON.stringify({ type: "subscribe", channels: [SESSION_A] }));
    const frames = socket.sent.map(decodeOutboundFrame);
    expect(frames.map((f) => f.type)).toEqual(["subscribe.ack", "snapshot"]);

    hub.publish(tokenEvent(10, "s-1"));
    const after = socket.sent.map(decodeOutboundFrame);
    expect(after.some((f) => f.type === "run.token")).toBe(true);

    // An unrelated session must not reach this socket.
    const before = socket.sent.length;
    hub.publish(tokenEvent(11, "s-2"));
    expect(socket.sent.length).toBe(before);
  });

  it("stops delivering after unsubscribe", () => {
    const hub = new RealtimeHub();
    const socket = new FakeSocket();
    const conn = hub.attach(socket);
    conn.handleMessage(JSON.stringify({ type: "subscribe", channels: [SESSION_A] }));
    conn.handleMessage(JSON.stringify({ type: "unsubscribe", channels: [SESSION_A] }));

    const before = socket.sent.length;
    hub.publish(tokenEvent(20, "s-1"));
    expect(socket.sent.length).toBe(before);
    const types = socket.sent.map((s) => decodeOutboundFrame(s).type);
    expect(types).toContain("unsubscribe.ack");
  });

  it("downgrades to status-only when the tab is unfocused", () => {
    const hub = new RealtimeHub();
    const socket = new FakeSocket();
    const conn = hub.attach(socket);
    conn.handleMessage(JSON.stringify({ type: "subscribe", channels: [SESSION_A] }));
    conn.handleMessage(JSON.stringify({ type: "tab_focus", focused: false, statusOnly: true }));

    hub.publish(tokenEvent(30, "s-1"));
    hub.publish(statusEvent(31, "s-1"));

    const types = socket.sent.map((s) => decodeOutboundFrame(s).type);
    expect(types).not.toContain("run.token");
    expect(types).toContain("run.status");
  });

  it("replays only deltas after lastSeq on resume", () => {
    const hub = new RealtimeHub();
    hub.publish(tokenEvent(1, "s-1"));
    hub.publish(tokenEvent(2, "s-1"));

    const socket = new FakeSocket();
    const conn = hub.attach(socket);
    conn.handleMessage(JSON.stringify({ type: "subscribe", channels: [SESSION_A], lastSeq: 1 }));

    const frames = socket.sent.map(decodeOutboundFrame);
    const seqs = frames.filter((f) => f.type === "run.token").map((f) => f.seq);
    expect(seqs).toEqual([2]);
  });

  it("ignores unknown frame types with an error frame", () => {
    const hub = new RealtimeHub();
    const socket = new FakeSocket();
    const conn = hub.attach(socket);
    conn.handleMessage(JSON.stringify({ type: "totally_unknown" }));
    const frame = decodeOutboundFrame(socket.sent[0]!);
    expect(frame.type).toBe("error");
  });

  it("answers ping with pong", () => {
    const hub = new RealtimeHub();
    const socket = new FakeSocket();
    const conn = hub.attach(socket);
    conn.handleMessage(JSON.stringify({ type: "ping", ts: 5 }));
    expect(decodeOutboundFrame(socket.sent[0]!)).toMatchObject({ type: "pong", ts: 5 });
  });

  it("routes workspace subscription to all sessions via snapshot store", () => {
    const store = new InMemorySnapshotStore();
    store.upsert({ runId: "r-1", sessionId: "s-1", status: "running", updatedAt: 1 });
    const hub = new RealtimeHub({ snapshotStore: store });
    const socket = new FakeSocket();
    const conn = hub.attach(socket);
    conn.handleMessage(JSON.stringify({ type: "subscribe", channels: ["workspace:w-1"] }));
    const snapshot = socket.sent.map(decodeOutboundFrame).find((f) => f.type === "snapshot");
    expect(snapshot).toBeDefined();
    expect((snapshot as Extract<LiveEvent, { type: "snapshot" }>).payload.activeRuns).toHaveLength(
      1,
    );
  });
});

describe("RealtimeHub auth", () => {
  it("rejects subscribe before auth and closes with 4401", async () => {
    const hub = new RealtimeHub({ auth: new StaticTokenAuth("good") });
    const socket = new FakeSocket();
    const conn = hub.attach(socket, { requireAuth: true });
    conn.handleMessage(JSON.stringify({ type: "subscribe", channels: [SESSION_A] }));
    await flushMicrotasks();

    const frame = decodeOutboundFrame(socket.sent[0]!) as { type: string; status?: number };
    expect(frame.type).toBe("error");
    expect(frame.status).toBe(401);
    expect(conn.closed).toBe(true);
    expect(socket.closed?.code).toBe(4401);
  });

  it("accepts a valid auth frame then allows subscribe", async () => {
    const hub = new RealtimeHub({ auth: new StaticTokenAuth("good") });
    const socket = new FakeSocket();
    const conn = hub.attach(socket, { requireAuth: true });
    conn.handleMessage(JSON.stringify({ type: "auth", token: "good" }));
    await flushMicrotasks();
    conn.handleMessage(JSON.stringify({ type: "subscribe", channels: [SESSION_A] }));

    const types = socket.sent.map((s) => decodeOutboundFrame(s).type);
    expect(types).toEqual(["auth.ack", "subscribe.ack", "snapshot"]);
  });

  it("rejects an invalid token with 401", async () => {
    const hub = new RealtimeHub({ auth: new StaticTokenAuth("good") });
    const socket = new FakeSocket();
    const conn = hub.attach(socket, { requireAuth: true });
    conn.handleMessage(JSON.stringify({ type: "auth", token: "bad" }));
    await flushMicrotasks();
    const frame = decodeOutboundFrame(socket.sent[0]!) as { status?: number };
    expect(frame.status).toBe(401);
    expect(conn.closed).toBe(true);
  });
});

describe("RealtimeConnection lifecycle", () => {
  it("reports cancel_run as not wired", () => {
    const hub = new RealtimeHub();
    const socket = new FakeSocket();
    const conn = hub.attach(socket);
    conn.handleMessage(JSON.stringify({ type: "cancel_run", runId: "r-1", sessionId: "s-1" }));
    expect(decodeOutboundFrame(socket.sent[0]!)).toMatchObject({ type: "error", status: 501 });
  });

  it("stops sending after close and detaches from the hub", () => {
    const hub = new RealtimeHub();
    const socket = new FakeSocket();
    const conn = hub.attach(socket);
    conn.handleMessage(JSON.stringify({ type: "subscribe", channels: [SESSION_A] }));
    hub.detach(conn.id);
    expect(hub.size).toBe(0);
    const before = socket.sent.length;
    hub.publish(tokenEvent(40, "s-1"));
    expect(socket.sent.length).toBe(before);
  });

  it("unregisters from the hub when the connection closes itself (401)", async () => {
    const hub = new RealtimeHub({ auth: new StaticTokenAuth("good") });
    const socket = new FakeSocket();
    const conn = hub.attach(socket, { requireAuth: true });
    expect(hub.size).toBe(1);
    conn.handleMessage(JSON.stringify({ type: "subscribe", channels: [SESSION_A] }));
    await flushMicrotasks();
    expect(conn.closed).toBe(true);
    // Self-close must not leak the connection in the hub registry.
    expect(hub.size).toBe(0);
  });

  it("keeps frame order for pipelined frames", async () => {
    const hub = new RealtimeHub({ auth: new StaticTokenAuth("good") });
    const socket = new FakeSocket();
    const conn = hub.attach(socket, { requireAuth: true });
    // Send auth + subscribe back-to-back before the auth promise resolves.
    conn.handleMessage(JSON.stringify({ type: "auth", token: "good" }));
    conn.handleMessage(JSON.stringify({ type: "subscribe", channels: [SESSION_A] }));
    await flushMicrotasks();
    await flushMicrotasks();
    const types = socket.sent.map((s) => decodeOutboundFrame(s).type);
    expect(types).toEqual(["auth.ack", "subscribe.ack", "snapshot"]);
  });

  it("answers ping even when an async auth is in flight", async () => {
    const hub = new RealtimeHub({ auth: new StaticTokenAuth("good") });
    const socket = new FakeSocket();
    const conn = hub.attach(socket, { requireAuth: true });
    conn.handleMessage(JSON.stringify({ type: "auth", token: "good" }));
    conn.handleMessage(JSON.stringify({ type: "ping", ts: 9 }));
    await flushMicrotasks();
    const types = socket.sent.map((s) => decodeOutboundFrame(s).type);
    expect(types).toEqual(["auth.ack", "pong"]);
  });

  it("exposes channel parsing errors as 400 frames", () => {
    const hub = new RealtimeHub();
    const socket = new FakeSocket();
    const conn = hub.attach(socket);
    conn.handleMessage(JSON.stringify({ type: "subscribe", channels: ["team:eng"] }));
    const frame = decodeOutboundFrame(socket.sent[0]!) as { status?: number; code?: string };
    expect(frame.status).toBe(400);
    expect(frame.code).toBe("invalid_channel");
  });

  it("exports RealtimeConnection for direct construction", () => {
    const socket = new FakeSocket();
    const conn = new RealtimeConnection("conn-x", { socket });
    expect(conn.id).toBe("conn-x");
    conn.close();
    expect(conn.closed).toBe(true);
  });

  it("closes the connection when the idle timeout elapses", () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const socket = new FakeSocket();
      const hub = new RealtimeHub({ now: () => now });
      const conn = hub.attach(socket, { heartbeat: true });

      // Exceed the 75s idle window without any inbound activity, then let a beat fire.
      now = 100_000;
      vi.advanceTimersByTime(25_000);

      expect(conn.closed).toBe(true);
      expect(socket.closed?.code).toBe(4408);
    } finally {
      vi.useRealTimers();
    }
  });
});
