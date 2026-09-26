import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const compose = readFileSync("docker-compose.yml", "utf8");

function serviceSlice(name: string, nextMarker: string): string {
  const start = compose.indexOf(`\n  ${name}:\n`);
  const end = compose.indexOf(nextMarker, start + 1);
  expect(start, name).toBeGreaterThan(-1);
  expect(end, name).toBeGreaterThan(start);
  return compose.slice(start, end);
}

describe("compose full stack profiles", () => {
  it("keeps redis, postgres, and litellm in the default set with healthchecks", () => {
    const slices = {
      redis: serviceSlice("redis", "\n  postgres:\n"),
      postgres: serviceSlice("postgres", "\n  # Intake HTTP"),
      orchestrator: serviceSlice("orchestrator", "\n  # Eve"),
      litellm: serviceSlice("litellm", "\n  # Decision sidecar"),
    };
    for (const name of ["redis", "postgres", "litellm"] as const) {
      expect(slices[name]).not.toContain("profiles:");
      expect(slices[name]).toContain("healthcheck:");
    }
    expect(slices.redis).toContain("127.0.0.1:${OPTIO_NEW_REDIS_HOST_PORT:-6379}:6379");
    expect(slices.redis).toContain("redis-cli");
    expect(slices.postgres).toContain("127.0.0.1:${OPTIO_NEW_POSTGRES_HOST_PORT:-5432}:5432");
    expect(slices.postgres).toContain("pg_isready");
    expect(slices.litellm).toContain("127.0.0.1:${OPTIO_NEW_LITELLM_HOST_PORT:-4000}:4000");
    expect(slices.litellm).toContain("/health/liveliness");
    expect(slices.orchestrator).toContain('profiles: ["full", "orchestrator"]');
    expect(slices.orchestrator).toContain("OPTIO_NEW_REDIS_URL: redis://redis:6379");
    expect(slices.orchestrator).toContain("127.0.0.1:3100:3100");
    expect(slices.orchestrator).toContain("condition: service_healthy");
    expect(slices.orchestrator).toContain("healthcheck:");
  });

  it("publishes eve-runner on 127.0.0.1:3210", () => {
    const block = serviceSlice("eve-runner", "\n  litellm:\n");
    expect(block).toContain('EVE_RUNNER_PORT: "3210"');
    expect(block).toContain('"127.0.0.1:3210:3210"');
    expect(block).toContain("http://127.0.0.1:3210/health");
    expect(block).not.toContain("3200");
  });
});
