import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("kit-harness compose profile", () => {
  it("defines the service only under profile harness", () => {
    const compose = readFileSync("docker-compose.yml", "utf8");
    const start = compose.indexOf("\n  kit-harness:\n");
    const end = compose.indexOf("\n  # Optional local Laya");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = compose.slice(start, end);
    expect(block).toContain('profiles: ["harness"]');
    expect(block).toContain("dockerfile: Dockerfile.kit-harness");
    expect(block).toContain("127.0.0.1:${KIT_HARNESS_PORT:-3200}:${KIT_HARNESS_PORT:-3200}");
    expect(block).toContain("/health");
    expect(readFileSync("Dockerfile.kit-harness", "utf8")).toContain("src/kit-harness");
  });
});
