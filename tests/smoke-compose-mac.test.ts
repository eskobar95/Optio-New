import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "smoke-compose-mac.sh");
const logs: string[] = [];

function fakePath(): string {
  const bin = mkdtempSync(path.join(tmpdir(), "optio-smoke-bin-"));
  logs.push(bin);
  for (const [name, target] of [
    ["docker", path.join(root, "tests", "fixtures", "fake-docker.sh")],
    ["curl", path.join(root, "tests", "fixtures", "fake-curl.sh")],
  ] as const) {
    const dest = path.join(bin, name);
    copyFileSync(target, dest);
    chmodSync(dest, 0o755);
  }
  return bin;
}

function run(args: string[], extraEnv: Record<string, string> = {}) {
  const logFile = path.join(mkdtempSync(path.join(tmpdir(), "optio-smoke-log-")), "docker.log");
  logs.push(path.dirname(logFile));
  const bin = fakePath();
  const result = spawnSync("bash", [script, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      FAKE_DOCKER_LOG: logFile,
      ...extraEnv,
    },
  });
  return { ...result, logFile };
}

afterEach(() => {
  for (const dir of logs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("smoke-compose-mac", () => {
  it("prints help without docker", () => {
    const result = spawnSync("bash", [script, "--help"], { cwd: root, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(".env.example");
    expect(result.stdout).toContain("--config-only");
  });

  it("rejects unknown arguments", () => {
    const result = spawnSync("bash", [script, "--nope"], { cwd: root, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown argument");
  });

  it("validates config without starting containers or writing .env", () => {
    const hadEnv = existsSync(path.join(root, ".env"));
    const result = run(["--config-only"], { FAKE_DOCKER_MODE: "no-lifecycle" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PASS: compose config");
    expect(result.stdout).toContain("PASS: default services include redis postgres litellm");
    expect(result.stdout).toContain("PASS: profile full includes orchestrator and eve-runner");
    expect(result.stdout).toContain("config-only; skipped up/down");
    const log = readFileSync(result.logFile, "utf8");
    expect(log).not.toContain(" up ");
    expect(log).not.toContain(" down ");
    expect(existsSync(path.join(root, ".env"))).toBe(hadEnv);
  });

  it("fails when litellm is missing from the default service set", () => {
    const result = run(["--config-only"], { FAKE_DOCKER_MODE: "missing-litellm" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing litellm");
  });

  it("fails when orchestrator is on the default service set", () => {
    const result = run(["--config-only"], { FAKE_DOCKER_MODE: "orchestrator-default" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("orchestrator is in the default service set");
  });

  it("runs isolated up and down for redis, postgres, and litellm", () => {
    const result = run([], {
      FAKE_DOCKER_MODE: "ok",
      OPTIO_NEW_SMOKE_WAIT_SECS: "5",
    });
    expect(result.status, `${result.stdout ?? ""}\n${result.stderr ?? ""}`).toBe(0);
    expect(result.stdout).toContain("PASS: redis ping");
    expect(result.stdout).toContain("PASS: postgres pg_isready");
    expect(result.stdout).toContain("PASS: litellm /health/liveliness");
    expect(result.stdout).toContain("PASS: compose down");
    const lines = readFileSync(result.logFile, "utf8").split("\n");
    const up = lines.find((line) => line.includes(" up "));
    expect(up).toContain("-p optio-new-mac-smoke");
    expect(up).toContain("up -d redis postgres litellm");
    expect(up).not.toContain("--profile full");
    expect(lines.some((line) => line.includes("down -v"))).toBe(true);
  });
});
