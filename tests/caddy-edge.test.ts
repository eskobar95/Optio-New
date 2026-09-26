import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function dockerComposeAvailable(): boolean {
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("Caddy TLS edge", () => {
  it("keeps the example Caddyfile free of a real host and mailbox", () => {
    const caddyfile = readFileSync("Caddyfile", "utf8");
    expect(caddyfile).toContain("{$OPTIO_NEW_WEBHOOK_HOST:localhost}");
    expect(caddyfile).toContain("{$OPTIO_NEW_ACME_EMAIL:tls-edge@localhost.invalid}");
    expect(caddyfile).toContain("handle /webhooks/*");
    expect(caddyfile).toContain("reverse_proxy orchestrator:3100");
    expect(caddyfile).not.toContain("handle /intake");
    expect(caddyfile).not.toMatch(/@(?!localhost\.invalid)\S+\.\S+/);
  });

  it("publishes 80/443 only on profile edge and leaves orchestrator on loopback", () => {
    const compose = readFileSync("docker-compose.yml", "utf8");
    expect(compose).toContain('profiles: ["edge"]');
    expect(compose).toContain('"127.0.0.1:3100:3100"');
    expect(compose).toContain("OPTIO_NEW_WEBHOOK_HOST: ${OPTIO_NEW_WEBHOOK_HOST:-localhost}");
    expect(compose).toContain(
      "OPTIO_NEW_ACME_EMAIL: ${OPTIO_NEW_ACME_EMAIL:-tls-edge@localhost.invalid}",
    );
    expect(compose).toContain(
      "OPTIO_NEW_INTAKE_WEBHOOK_SECRET: ${OPTIO_NEW_INTAKE_WEBHOOK_SECRET:-}",
    );
    expect(compose).toContain('- "80:80"');
    expect(compose).toContain('- "443:443"');

    const unit = readFileSync("deploy/systemd/optio-new-compose.service", "utf8");
    expect(unit).toContain("Environment=COMPOSE_PROFILES=harness,orchestrator");
    expect(unit).not.toMatch(/COMPOSE_PROFILES=.*edge/);

    const doc = readFileSync("docs/ops/caddy-tls-edge.md", "utf8");
    expect(doc).toContain("127.0.0.1:3100");
    expect(doc).toContain("OPTIO_NEW_ACME_EMAIL");
    expect(doc).toContain("X-Optio-Signature");
    expect(doc).toContain("profile `edge`");
  });

  it("appends nothing until the host drop-in exists", () => {
    const script = readFileSync("scripts/vps-pull-rebuild.sh", "utf8");
    expect(script).toContain("/etc/systemd/system/optio-new-compose.service.d/edge.conf");
    const example = readFileSync("deploy/systemd/optio-new-edge.conf.example", "utf8");
    expect(example).toContain("Environment=COMPOSE_PROFILES=harness,orchestrator,edge");
  });

  it.skipIf(!dockerComposeAvailable())(
    "compose config omits caddy unless profile edge is selected",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "optio-new-edge-"));
      const envFile = join(dir, "empty.env");
      writeFileSync(envFile, "");

      const render = (profiles: string | undefined) => {
        const env = { ...process.env };
        if (profiles === undefined) delete env.COMPOSE_PROFILES;
        else env.COMPOSE_PROFILES = profiles;
        const raw = execFileSync(
          "docker",
          ["compose", "--env-file", envFile, "config", "--format", "json"],
          { encoding: "utf8", env },
        );
        return JSON.parse(raw) as {
          services: Record<
            string,
            {
              ports?: Array<{ host_ip?: string; published?: string | number; target?: number }>;
            }
          >;
        };
      };

      const defaults = render(undefined);
      expect(defaults.services.caddy).toBeUndefined();

      const edge = render("edge");
      expect(edge.services.caddy).toBeTruthy();
      const ports = edge.services.caddy.ports ?? [];
      for (const published of ["80", "443"]) {
        const match = ports.find((port) => String(port.published) === published);
        expect(match, published).toBeTruthy();
        expect(match?.host_ip ?? "").not.toBe("127.0.0.1");
      }

      const boot = render("harness,orchestrator");
      expect(boot.services.caddy).toBeUndefined();
      const orchestratorPorts = boot.services.orchestrator.ports ?? [];
      expect(
        orchestratorPorts.some(
          (port) => port.host_ip === "127.0.0.1" && String(port.published) === "3100",
        ),
      ).toBe(true);
    },
  );
});
