import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const BOOT_PROFILES = "harness,orchestrator";

const UNITS = [
  "deploy/systemd/optio-new-compose.service",
  "deploy/systemd/agent-harness-compose.service",
];

function dockerComposeAvailable(): boolean {
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("Hetzner kit-harness deploy", () => {
  it("boots litellm, harness, and orchestrator from /opt/optio-new", () => {
    for (const path of UNITS) {
      const unit = readFileSync(path, "utf8");
      expect(unit).toContain("WorkingDirectory=/opt/optio-new");
      expect(unit).toContain(`Environment=COMPOSE_PROFILES=${BOOT_PROFILES}`);
      expect(unit).toContain("/opt/optio-new/scripts/secrets.sh compose up -d");
      expect(unit).toContain("SOPS_AGE_KEY_FILE=/opt/optio-new/secrets/age/key.txt");
      expect(unit).toContain("docker compose -f /opt/optio-new/docker-compose.yml down");
      expect(unit).not.toContain("down -v");
      expect(unit).not.toMatch(/^\s*EnvironmentFile=/m);
      expect(unit.toLowerCase()).not.toContain("ssh");
    }
  });

  it("publishes kit-harness on loopback port 3200", () => {
    const compose = readFileSync("docker-compose.yml", "utf8");
    expect(compose).not.toContain('profiles: ["litellm"]');
    expect(compose.match(/^ {2}kit-harness:$/gm)).toHaveLength(1);
    expect(compose).toContain('profiles: ["harness"]');
    expect(compose).toContain('profiles: ["full", "orchestrator"]');
    expect(compose).toContain("127.0.0.1:${KIT_HARNESS_PORT:-3200}:${KIT_HARNESS_PORT:-3200}");
    expect(compose).toContain("127.0.0.1:${OPTIO_NEW_LITELLM_HOST_PORT:-4000}:4000");
    expect(compose).toContain('"127.0.0.1:3100:3100"');
    expect(compose).toContain("dockerfile: Dockerfile.kit-harness");
    expect(compose).not.toContain("0.0.0.0:3200");
    expect(compose).not.toContain("./deploy/kit-harness");

    const portLines = compose
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- "') && line.endsWith('"') && line.includes(":"));
    for (const line of portLines) {
      if (line === '- "80:80"' || line === '- "443:443"') continue;
      expect(line.startsWith('- "127.0.0.1:'), line).toBe(true);
    }
  });

  it("documents pull+rebuild, rollback, and the secrets/DNS checklist", () => {
    const doc = readFileSync("deploy/README.md", "utf8");
    expect(doc).toContain("/opt/optio-new");
    expect(doc).toContain("127.0.0.1:3200");
    expect(doc).toContain("scripts/vps-pull-rebuild.sh");
    expect(doc).toContain("--build");
    expect(doc).toContain("down -v");
    expect(doc).toContain("OPTIO_NEW_WEBHOOK_HOST");
    expect(doc).toContain("LITELLM_MASTER_KEY");
    expect(doc).toContain("Hetzner Cloud Firewall");
    expect(doc).toContain("opens a remote shell");
  });

  it("rebuild script stays on the host and refuses this checkout", () => {
    const script = readFileSync("scripts/vps-pull-rebuild.sh", "utf8");
    expect(script).toContain("OPTIO_NEW_DEPLOY_ROOT:-/opt/optio-new");
    expect(script).toContain("git pull --ff-only origin main");
    expect(script).toContain("compose up -d --build --pull always");
    expect(script).toContain("COMPOSE_PROFILES");
    expect(script.toLowerCase()).not.toContain("ssh");

    const before = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
    });
    let stderr = "";
    let status = 0;
    try {
      execFileSync("bash", ["scripts/vps-pull-rebuild.sh"], { encoding: "utf8" });
    } catch (error) {
      const failed = error as { status?: number; stderr?: string };
      status = failed.status ?? 0;
      stderr = failed.stderr ?? "";
    }
    expect(status).toBe(1);
    expect(stderr).toContain("/opt/optio-new");
    const after = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
    });
    expect(after).toBe(before);
  });

  it.skipIf(!dockerComposeAvailable())("compose config binds kit-harness to 127.0.0.1:3200", () => {
    const dir = mkdtempSync(join(tmpdir(), "optio-new-env-"));
    const envFile = join(dir, "empty.env");
    writeFileSync(envFile, "");
    const raw = execFileSync(
      "docker",
      ["compose", "--env-file", envFile, "config", "--format", "json"],
      {
        encoding: "utf8",
        env: { ...process.env, COMPOSE_PROFILES: BOOT_PROFILES },
      },
    );
    const config = JSON.parse(raw) as {
      services: Record<
        string,
        { ports?: Array<{ host_ip?: string; published?: string | number }> }
      >;
    };
    for (const name of ["kit-harness", "litellm", "orchestrator"]) {
      expect(config.services[name], name).toBeTruthy();
    }
    const harnessPorts = config.services["kit-harness"].ports ?? [];
    expect(
      harnessPorts.some(
        (port) => port.host_ip === "127.0.0.1" && String(port.published) === "3200",
      ),
    ).toBe(true);
  });
});
