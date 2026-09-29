import { describe, expect, it } from "vitest";
import { encodeFrame } from "../src/realtime/framing.js";
import {
  LiveEventDispatcher,
  LiveSocketEventSource,
  TauriLiveEventSource,
  TAURI_EVENT_TOPIC,
  type LiveSocket,
} from "../src/realtime/client.js";
import { StaticTokenAuth } from "../src/realtime/auth.js";
import type { ClientFrame, LiveEvent, OutboundFrame } from "../src/realtime/types.js";

const SESSION_A = "session:s-1" as const;

function tokenEvent(seq: number, text = "x"): LiveEvent {
  return {
    type: "run.token",
    seq,
    channel: SESSION_A,
    ts: seq,
    payload: { runId: "r-1", sessionId: "s-1", text },
  };
}

class ScriptedSocket implements LiveSocket {
  sent: string[] = [];
  closeCode: { code?: number; reason?: string } | null = null;
  onopen?: () => void;
  onmessage?: (data: string) => void;
  onclose?: (code: number, reason: string, status?: number) => void;

  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closeCode = { code, reason };
  }

  open(): void {
    this.onopen?.();
  }
  deliver(frame: OutboundFrame): void {
    this.onmessage?.(encodeFrame(frame));
  }
  serverClose(code: number, reason: string, status?: number): void {
    this.onclose?.(code, reason, status);
  }
  sentFrames(): ClientFrame[] {
    return this.sent.map((s) => JSON.parse(s) as ClientFrame);
  }
}

function makeManualScheduler() {
  const timers: Array<{ fn: () => void; ms: number }> = [];
  return {
    timers,
    schedule: (fn: () => void, ms: number) => {
      const handle = { fn, ms };
      timers.push(handle);
      return handle;
    },
    cancelSchedule: (handle: unknown) => {
      const index = timers.indexOf(handle as { fn: () => void; ms: number });
      if (index >= 0) timers.splice(index, 1);
    },
    runNext: () => {
      const next = timers.shift();
      next?.fn();
    },
  };
}

describe("LiveEventDispatcher", () => {
  it("tracks lastSeq and forwards live events", () => {
    const events: LiveEvent[] = [];
    const dispatcher = new LiveEventDispatcher((e) => events.push(e));
    dispatcher.push(encodeFrame(tokenEvent(1)));
    dispatcher.push(encodeFrame(tokenEvent(2)));
    expect(dispatcher.lastSeq).toBe(2);
    expect(events.map((e) => e.type)).toEqual(["run.token", "run.token"]);
  });

  it("does not forward control frames as live events", () => {
    const events: LiveEvent[] = [];
    const dispatcher = new LiveEventDispatcher((e) => events.push(e));
    dispatcher.push(encodeFrame({ type: "pong", ts: 1 }));
    expect(events).toHaveLength(0);
  });

  it("rejects malformed frames", () => {
    const dispatcher = new LiveEventDispatcher(() => {});
    expect(() => dispatcher.push("not json")).toThrow();
  });
});

describe("LiveSocketEventSource", () => {
  it("auths and subscribes with lastSeq on open, and reconnects with backoff", () => {
    const socket = new ScriptedSocket();
    const events: LiveEvent[] = [];
    const states: string[] = [];
    const scheduler = makeManualScheduler();

    const source = new LiveSocketEventSource({
      connect: () => socket,
      channels: [SESSION_A],
      authToken: "tok",
      onEvent: (e) => events.push(e),
      onState: (s) => states.push(s),
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancelSchedule,
    });

    source.start();
    socket.open();
    expect(socket.sentFrames()).toEqual([
      { type: "auth", token: "tok" },
      { type: "subscribe", channels: [SESSION_A] },
    ]);

    // Deliver an event, then drop the connection.
    socket.deliver(tokenEvent(1, "hello"));
    expect(events).toHaveLength(1);
    socket.serverClose(1006, "network");

    expect(states).toContain("reconnecting");
    expect(scheduler.timers).toHaveLength(1);
  });

  it("resumes with lastSeq after reconnect", () => {
    let socketIndex = 0;
    const sockets = [new ScriptedSocket(), new ScriptedSocket()];
    const scheduler = makeManualScheduler();

    const source = new LiveSocketEventSource({
      connect: () => sockets[socketIndex++]!,
      channels: [SESSION_A],
      onEvent: () => {},
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancelSchedule,
    });

    source.start();
    sockets[0]!.open();
    sockets[0]!.deliver(tokenEvent(5));
    sockets[0]!.serverClose(1006, "drop");

    scheduler.runNext();
    sockets[1]!.open();
    const sub = sockets[1]!.sentFrames().find((f) => f.type === "subscribe");
    expect(sub).toMatchObject({ type: "subscribe", lastSeq: 5 });
  });

  it("stops the reconnect loop on a 401 close", () => {
    const socket = new ScriptedSocket();
    const scheduler = makeManualScheduler();
    const states: string[] = [];
    const source = new LiveSocketEventSource({
      connect: () => socket,
      channels: [SESSION_A],
      onEvent: () => {},
      onState: (s) => states.push(s),
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancelSchedule,
    });
    source.start();
    socket.open();
    socket.serverClose(4401, "unauthorized", 401);

    expect(source.state).toBe("closed");
    expect(scheduler.timers).toHaveLength(0);
  });

  it("stops the loop when the server sends an error frame with status 401", () => {
    const socket = new ScriptedSocket();
    const source = new LiveSocketEventSource({
      connect: () => socket,
      channels: [SESSION_A],
      onEvent: () => {},
      schedule: makeManualScheduler().schedule,
      cancelSchedule: () => {},
    });
    source.start();
    socket.open();
    socket.deliver({ type: "error", code: "auth_required", message: "nope", status: 401 });
    expect(source.state).toBe("closed");
  });

  it("cancels a pending reconnect timer on start() (no double socket)", () => {
    const scheduler = makeManualScheduler();
    const sockets: ScriptedSocket[] = [];
    let opened = 0;
    const source = new LiveSocketEventSource({
      connect: () => {
        opened += 1;
        const socket = new ScriptedSocket();
        sockets.push(socket);
        return socket;
      },
      channels: [SESSION_A],
      onEvent: () => {},
      schedule: scheduler.schedule,
      cancelSchedule: scheduler.cancelSchedule,
    });

    source.start();
    sockets[0]!.open();
    sockets[0]!.serverClose(1006, "drop");
    expect(scheduler.timers).toHaveLength(1);

    source.start();
    expect(scheduler.timers).toHaveLength(0);
    expect(opened).toBe(2);
  });

  it("reports connect failures via onTransportError instead of swallowing them", () => {
    const errors: unknown[] = [];
    const scheduler = makeManualScheduler();
    const source = new LiveSocketEventSource({
      connect: () => {
        throw new Error("boom");
      },
      channels: [SESSION_A],
      onEvent: () => {},
      onTransportError: (e) => errors.push(e),
      schedule: scheduler.schedule,
      cancelSchedule: () => {},
    });
    source.start();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("boom");
    expect(scheduler.timers).toHaveLength(1);
  });

  it("surfaces malformed frames via onTransportError and keeps the socket open", () => {
    const errors: unknown[] = [];
    const socket = new ScriptedSocket();
    const source = new LiveSocketEventSource({
      connect: () => socket,
      channels: [SESSION_A],
      onEvent: () => {},
      onTransportError: (e) => errors.push(e),
      schedule: makeManualScheduler().schedule,
      cancelSchedule: () => {},
    });
    source.start();
    socket.open();
    socket.onmessage?.("not json");
    expect(errors).toHaveLength(1);
    expect(source.state).toBe("open");
  });

  it("subscribe/unsubscribe update the frame sent and setFocused downgrades", () => {
    const socket = new ScriptedSocket();
    const source = new LiveSocketEventSource({
      connect: () => socket,
      channels: [SESSION_A],
      onEvent: () => {},
      schedule: makeManualScheduler().schedule,
      cancelSchedule: () => {},
    });
    source.start();
    socket.open();
    socket.sent.length = 0;

    source.subscribe(["session:s-2" as const]);
    source.unsubscribe([SESSION_A]);
    source.setFocused(false);

    expect(socket.sentFrames()).toEqual([
      { type: "subscribe", channels: ["session:s-2"] },
      { type: "unsubscribe", channels: [SESSION_A] },
      { type: "tab_focus", focused: false, statusOnly: true },
    ]);
  });

  it("works with the shared StaticTokenAuth contract (401 semantics)", () => {
    expect(() => new StaticTokenAuth("good").verify("bad")).toThrow(
      expect.objectContaining({ status: 401 }),
    );
  });
});

describe("TauriLiveEventSource", () => {
  it("normalizes Tauri IPC payloads into the same live events as WS", async () => {
    const listeners = new Map<string, (payload: string) => void>();
    const emitted: Array<{ event: string; payload: string }> = [];
    const events: LiveEvent[] = [];

    const source = new TauriLiveEventSource(
      {
        listen: async (event, handler) => {
          listeners.set(event, handler);
          return () => listeners.delete(event);
        },
        emit: (event, payload) => {
          emitted.push({ event, payload });
        },
      },
      (e) => events.push(e),
    );

    await source.start();
    expect(source.state).toBe("open");
    listeners.get(TAURI_EVENT_TOPIC)?.(encodeFrame(tokenEvent(7, "local")));
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ text: "local" });

    source.send({ type: "ping" });
    expect(emitted[0]?.event).toBe(TAURI_EVENT_TOPIC);

    await source.stop();
    expect(source.state).toBe("closed");
  });
});
