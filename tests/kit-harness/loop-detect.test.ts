import { describe, expect, it } from "vitest";
import { detectLoop } from "../../src/kit-harness/index.js";

const fail = (fingerprint: string, tool = "run_tests") => ({
  fingerprint,
  tool,
  outcome: "fail" as const,
});

describe("detectLoop", () => {
  it("stays quiet below the fingerprint threshold", () => {
    const result = detectLoop({
      events: [fail("fp-a", "edit_file"), fail("fp-a", "grep"), fail("fp-b", "shell")],
    });
    expect(result).toEqual({ loop_detected: false, reason: "no_loop" });
  });

  it("suggests replan on three identical failure fingerprints", () => {
    const result = detectLoop({
      events: [fail("fp-a", "edit_file"), fail("fp-b"), fail("fp-a"), fail("fp-a")],
    });
    expect(result).toMatchObject({
      loop_detected: true,
      kind: "repeated_failure",
      suggestion: "replan",
      fingerprint: "fp-a",
      count: 3,
      reason: "failure_fingerprint_replan",
    });
  });

  it("suggests stop when the same fingerprint keeps failing", () => {
    const result = detectLoop({
      events: [fail("fp-a"), fail("fp-a"), fail("fp-a"), fail("fp-a"), fail("fp-a")],
    });
    expect(result).toMatchObject({
      loop_detected: true,
      suggestion: "stop",
      count: 5,
      reason: "failure_fingerprint_stop",
    });
  });

  it("suggests stop when the same tool fails three times in a row", () => {
    const result = detectLoop({
      events: [
        { fingerprint: "one", tool: "shell", outcome: "fail" },
        { fingerprint: "two", tool: "shell", outcome: "fail" },
        { fingerprint: "three", tool: "Shell", outcome: "fail" },
      ],
    });
    expect(result).toMatchObject({
      loop_detected: true,
      kind: "tool_thrash",
      suggestion: "stop",
      tool: "shell",
      count: 3,
      reason: "tool_thrash_stop",
    });
  });

  it("breaks a tool streak on success", () => {
    const result = detectLoop({
      events: [
        fail("one", "shell"),
        fail("two", "shell"),
        { fingerprint: "ok", tool: "shell", outcome: "ok" },
        fail("three", "shell"),
        fail("four", "shell"),
      ],
    });
    expect(result.loop_detected).toBe(false);
  });

  it("does not count deny outcomes as failures", () => {
    const result = detectLoop({
      events: [
        { fingerprint: "same", tool: "read_secret", outcome: "deny" },
        { fingerprint: "same", tool: "read_secret", outcome: "deny" },
        { fingerprint: "same", tool: "read_secret", outcome: "deny" },
      ],
    });
    expect(result.loop_detected).toBe(false);
  });
});
