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

describe("compose flue sidecar", () => {
  it("publishes flue on 127.0.0.1:3220 under profile flue", () => {
    expect(compose).toContain("`--profile flue`");
    const block = serviceSlice("flue", "\n  # Failure fingerprints");
    expect(block).toContain('profiles: ["flue"]');
    expect(block).toContain("Dockerfile.flue");
    expect(block).toContain("FLUE_PORT: ${FLUE_PORT:-3220}");
    expect(block).toContain('"127.0.0.1:${FLUE_PORT:-3220}:${FLUE_PORT:-3220}"');
    expect(block).toContain("/health");
    expect(block).toContain("healthcheck:");
  });

  it("Dockerfile.flue mirrors kit-harness stub pattern", () => {
    const dockerfile = readFileSync("Dockerfile.flue", "utf8");
    expect(dockerfile).toContain("node:22-alpine");
    expect(dockerfile).toContain("tsconfig.flue.json");
    expect(dockerfile).toContain("FLUE_PORT=3220");
    expect(dockerfile).toContain("dist/flue/main.js");
    expect(dockerfile).not.toContain("CURSOR_API_KEY");
  });
});
