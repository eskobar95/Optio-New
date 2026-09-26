import { describe, expect, it } from "vitest";
import { UnrecoverableError } from "bullmq";
import {
  PrSafetyClosedError,
  collectPrSafetyInput,
  evaluatePrSafetyGate,
  type PrSafetyInput,
  type ShellRunner,
} from "../src/index.js";

function passedChecks(): PrSafetyInput["checks"] {
  return {
    test: { exitCode: 0 },
    lint: { exitCode: 0 },
    typecheck: { exitCode: 0 },
  };
}

function unified(filePath: string, added: string): string {
  return [
    `diff --git a/${filePath} b/${filePath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${filePath}`,
    "@@ -0,0 +1 @@",
    `+${added}`,
    "",
  ].join("\n");
}

const cleanDiff = unified("src/app.ts", "export const ready = true;");

describe("evaluatePrSafetyGate", () => {
  it("fails closed when checks were not run", () => {
    expect(evaluatePrSafetyGate(undefined)).toMatchObject({
      verdict: "fail",
      reason: "tests_not_run",
      hard: true,
    });
    expect(evaluatePrSafetyGate({ diff: cleanDiff })).toMatchObject({ reason: "tests_not_run" });
    expect(
      evaluatePrSafetyGate({
        checks: { test: { exitCode: 0 }, typecheck: { exitCode: 0 } },
        diff: cleanDiff,
      }),
    ).toMatchObject({ verdict: "fail", reason: "lint_not_run", hard: true });
  });

  it("fails closed when lint, tests, or typecheck exit non-zero", () => {
    expect(
      evaluatePrSafetyGate({
        checks: { ...passedChecks(), test: { exitCode: 1 } },
        diff: cleanDiff,
      }),
    ).toMatchObject({ verdict: "fail", reason: "tests_failed" });
    expect(
      evaluatePrSafetyGate({
        checks: { ...passedChecks(), lint: { exitCode: 2 } },
        diff: cleanDiff,
      }),
    ).toMatchObject({ verdict: "fail", reason: "lint_failed" });
    expect(
      evaluatePrSafetyGate({
        checks: { ...passedChecks(), typecheck: { exitCode: 1 } },
        diff: cleanDiff,
      }),
    ).toMatchObject({ verdict: "fail", reason: "typecheck_failed" });
  });

  it("fails closed when the diff was not reviewed", () => {
    expect(evaluatePrSafetyGate({ checks: passedChecks() })).toMatchObject({
      verdict: "fail",
      reason: "diff_not_reviewed",
      hard: true,
    });
  });

  it("passes a clean diff when every check exited 0", () => {
    expect(evaluatePrSafetyGate({ checks: passedChecks(), diff: cleanDiff })).toMatchObject({
      verdict: "pass",
      reason: "checks_passed",
      hard: false,
      findings: [],
    });
    expect(evaluatePrSafetyGate({ checks: passedChecks(), diff: "" })).toMatchObject({
      verdict: "pass",
      reason: "checks_passed",
    });
  });

  it("blocks a secret file and does not echo the secret", () => {
    const secret = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const decision = evaluatePrSafetyGate({
      checks: passedChecks(),
      diff: unified(".env", `AWS_ACCESS_KEY_ID=${secret}`),
    });
    expect(decision).toMatchObject({
      verdict: "fail",
      reason: "secret_in_diff",
      hard: true,
    });
    expect(decision.findings[0]).toEqual({ kind: "secret", path: ".env", rule: "dotenv" });
    expect(JSON.stringify(decision)).not.toContain(secret);
  });

  it("blocks a private key and a token on an otherwise normal path", () => {
    const pem = ["-----BEGIN ", "RSA PRIVATE KEY-----"].join("");
    const keyFile = evaluatePrSafetyGate({
      checks: passedChecks(),
      diff: unified("src/keys.ts", pem),
    });
    expect(keyFile.reason).toBe("secret_in_diff");
    expect(keyFile.findings).toContainEqual({
      kind: "secret",
      path: "src/keys.ts",
      rule: "private_key",
    });

    const token = "ghp_" + "a".repeat(36);
    const tokenDiff = evaluatePrSafetyGate({
      checks: passedChecks(),
      diff: unified("src/auth.ts", `const token = "${token}";`),
    });
    expect(tokenDiff.reason).toBe("secret_in_diff");
    expect(tokenDiff.findings).toContainEqual({
      kind: "secret",
      path: "src/auth.ts",
      rule: "github_token",
    });
    expect(JSON.stringify(tokenDiff)).not.toContain(token);
  });

  it("allows example env files and ignores secrets on removed or context lines", () => {
    const secret = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const example = evaluatePrSafetyGate({
      checks: passedChecks(),
      diff: unified(".env.example", "AWS_ACCESS_KEY_ID="),
    });
    expect(example.verdict).toBe("pass");

    const removed = [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1 +1 @@",
      `-${secret}`,
      "+export const ok = 1;",
      "",
    ].join("\n");
    expect(evaluatePrSafetyGate({ checks: passedChecks(), diff: removed }).verdict).toBe("pass");

    const deleted = [
      "diff --git a/.env b/.env",
      "deleted file mode 100644",
      "--- a/.env",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      `-${secret}`,
      "",
    ].join("\n");
    expect(evaluatePrSafetyGate({ checks: passedChecks(), diff: deleted }).verdict).toBe("pass");

    const context = [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,2 +1,2 @@",
      ` ${secret}`,
      "+export const renamed = true;",
      "",
    ].join("\n");
    const kept = evaluatePrSafetyGate({ checks: passedChecks(), diff: context });
    expect(kept.verdict).toBe("pass");
    expect(JSON.stringify(kept)).not.toContain(secret);
  });

  it("blocks destructive commands and unsafe paths with a stable reason", () => {
    const wipe = ["rm ", "-rf /tmp/proj"].join("");
    const command = evaluatePrSafetyGate({
      checks: passedChecks(),
      diff: unified("scripts/wipe.sh", wipe),
    });
    expect(command).toMatchObject({ verdict: "fail", reason: "destructive_path", hard: true });
    expect(command.findings[0]).toEqual({
      kind: "destructive",
      path: "scripts/wipe.sh",
      rule: "rm_rf",
    });

    const escape = evaluatePrSafetyGate({
      checks: passedChecks(),
      diff: unified("../outside.txt", "owned"),
    });
    expect(escape.reason).toBe("destructive_path");
    expect(escape.findings[0]?.rule).toBe("path_escape");
  });

  it("names a secret ahead of a failing lint check", () => {
    const decision = evaluatePrSafetyGate({
      checks: { ...passedChecks(), lint: { exitCode: 1 } },
      diff: unified("secrets/api.txt", "material"),
    });
    expect(decision.reason).toBe("secret_in_diff");
    expect(decision.findings[0]).toEqual({
      kind: "secret",
      path: "secrets/api.txt",
      rule: "secrets_dir",
    });
  });
});

describe("collectPrSafetyInput", () => {
  it("reads the diff before tests, lint, and typecheck", async () => {
    const calls: string[] = [];
    const shell: ShellRunner = {
      async run(_cwd, command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "npm" && args[0] === "test") return { exitCode: undefined, stdout: "" };
        if (command === "npm") return { exitCode: 0, stdout: "" };
        if (args[0] === "ls-files") return { exitCode: 0, stdout: "notes.env\0" };
        if (args.includes("--no-index")) {
          return { exitCode: 1, stdout: unified("notes.env", "TOKEN=local") };
        }
        return { exitCode: 0, stdout: "" };
      },
    };
    const input = await collectPrSafetyInput("/work/task", { base: "development", shell });
    expect(calls).toEqual([
      "git diff development...HEAD",
      "git diff HEAD",
      "git ls-files -z --others --exclude-standard",
      "git diff --no-index -- /dev/null notes.env",
      "npm test",
      "npm run lint",
      "npm run typecheck",
    ]);
    expect(input.checks?.test?.exitCode).toBeUndefined();
    expect(evaluatePrSafetyGate(input).reason).toBe("tests_not_run");
  });

  it("does not run npm when the diff has a secret", async () => {
    const calls: string[] = [];
    const secret = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const shell: ShellRunner = {
      async run(_cwd, command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "npm") return { exitCode: 0, stdout: "" };
        return { exitCode: 0, stdout: unified(".env", secret) };
      },
    };
    const input = await collectPrSafetyInput("/work/task", { base: "development", shell });
    expect(calls.some((call) => call.startsWith("npm "))).toBe(false);
    const decision = evaluatePrSafetyGate(input);
    expect(decision.reason).toBe("secret_in_diff");
    expect(JSON.stringify(decision)).not.toContain(secret);
  });

  it("does not pass an unsafe base ref to git and does not run npm", async () => {
    const calls: string[] = [];
    const shell: ShellRunner = {
      async run(_cwd, command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        return { exitCode: 0, stdout: "" };
      },
    };
    const input = await collectPrSafetyInput("/work/task", {
      base: "development;touch /tmp/x",
      shell,
    });
    expect(input.diff).toBeUndefined();
    expect(calls).toEqual([]);
    expect(evaluatePrSafetyGate(input).reason).toBe("tests_not_run");
  });
});

describe("PrSafetyClosedError", () => {
  it("is unrecoverable and names the rule without the secret", () => {
    const secret = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const decision = evaluatePrSafetyGate({
      checks: passedChecks(),
      diff: unified(".env", secret),
    });
    const error = new PrSafetyClosedError(decision);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error.message).toBe("pr safety gate closed: secret_in_diff .env (dotenv)");
    expect(error.message).not.toContain(secret);
    expect(error.decision.reason).toBe("secret_in_diff");
  });
});
