import { describe, expect, it } from "vitest";
import { decideTool } from "../../src/kit-harness/index.js";
import { ADVISOR_CONFIDENCE_MIN, type DecisionAdvisor } from "../../src/kit-harness/types.js";

describe("decideTool", () => {
  it("allows a normal read", async () => {
    const decision = await decideTool("read_file", { path: "src/kit-harness/server.ts" });
    expect(decision).toMatchObject({ decision: "allow", reason: "allow_tool", hard: false });
  });

  it("hard-denies secret tools and secret paths", async () => {
    const tool = await decideTool("read_secret");
    expect(tool).toMatchObject({
      decision: "deny",
      reason: "hard_deny_tool",
      hard: true,
      engine: "rules",
    });

    const path = await decideTool("read_file", { path: ".env" });
    expect(path).toMatchObject({ decision: "deny", reason: "hard_deny_secret", hard: true });

    const command = await decideTool("shell", { command: "cat secrets/age.key" });
    expect(command.reason).toBe("hard_deny_secret");
  });

  it("does not treat file body text as a path", async () => {
    const decision = await decideTool("write_file", {
      path: "src/app.ts",
      args: { content: "const note = '.env is gitignored';" },
    });
    expect(decision.decision).toBe("allow");
  });

  it("hard-denies destructive commands and protected-branch pushes", async () => {
    const force = await decideTool("shell", { command: "git push --force origin feature/x" });
    expect(force).toMatchObject({ decision: "deny", reason: "hard_deny_destructive", hard: true });

    const main = await decideTool("git_push", { command: "git push origin main" });
    expect(main.reason).toBe("hard_deny_destructive");

    const reset = await decideTool("shell", { command: "git reset --hard HEAD~1" });
    expect(reset.decision).toBe("deny");

    const clean = await decideTool("shell", { command: "git clean -fd" });
    expect(clean.reason).toBe("hard_deny_destructive");
  });

  it("confirms an ordinary feature push", async () => {
    const decision = await decideTool("git_push", { command: "git push origin feature/kit" });
    expect(decision).toMatchObject({ decision: "confirm", reason: "confirm_tool", hard: false });
  });

  it("allows a test command and confirms curl", async () => {
    const tests = await decideTool("shell", { command: "npm test" });
    expect(tests).toMatchObject({ decision: "allow", reason: "safe_command" });

    const curl = await decideTool("shell", { command: "curl https://example.com" });
    expect(curl.decision).toBe("confirm");
  });

  it("denies tools outside the step allow-list before asking the advisor", async () => {
    const calls = { n: 0 };
    const advisor: DecisionAdvisor = {
      async advise() {
        calls.n += 1;
        return { choice: "allow", confidence: 1 };
      },
    };
    const decision = await decideTool("git_push", { allowed_tools: ["read_file"] }, advisor);
    expect(decision).toMatchObject({ decision: "deny", reason: "not_in_allowlist", hard: true });
    expect(calls.n).toBe(0);
  });

  it("ignores an advisor allow on a hard secret deny", async () => {
    const calls = { n: 0 };
    const advisor: DecisionAdvisor = {
      async advise() {
        calls.n += 1;
        return { choice: "allow", confidence: ADVISOR_CONFIDENCE_MIN, reason: "mock" };
      },
    };
    const decision = await decideTool("read_file", { path: "id_rsa" }, advisor);
    expect(decision).toMatchObject({ decision: "deny", hard: true, engine: "rules" });
    expect(calls.n).toBe(0);
  });

  it("accepts a confident soft deny from the advisor", async () => {
    const advisor: DecisionAdvisor = {
      async advise(input) {
        expect(input.kind).toBe("tool_gate");
        return { choice: "deny", confidence: 0.95 };
      },
    };
    const decision = await decideTool("read_file", { path: "src/index.ts" }, advisor);
    expect(decision).toMatchObject({
      decision: "deny",
      reason: "advisor",
      engine: "jev",
      hard: false,
    });
  });

  it("denies an unknown tool", async () => {
    const decision = await decideTool("launch_missiles");
    expect(decision).toMatchObject({ decision: "deny", reason: "unknown_tool" });
  });
});
