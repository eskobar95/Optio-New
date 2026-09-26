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

  it("installs production dependencies without lifecycle scripts", () => {
    const dockerfiles = [
      "Dockerfile.kit-harness",
      "Dockerfile.orchestrator",
      "Dockerfile.eve-runner",
    ];
    for (const name of dockerfiles) {
      const lines = readFileSync(name, "utf8").split("\n");
      for (const line of lines) {
        if (line.includes("npm ci") && line.includes("--omit=dev")) {
          expect(line, name).toContain("--ignore-scripts");
        }
      }
    }

    const dockerfile = readFileSync("Dockerfile.kit-harness", "utf8");
    const stages = dockerfile.split(/^FROM /m).slice(1);
    const build = stages.find((stage) => stage.includes("AS build")) ?? "";
    const runtime = stages.find((stage) => !stage.includes("AS build")) ?? "";
    expect(build).toMatch(/\nRUN npm ci\n/);
    expect(runtime).toContain("RUN npm ci --omit=dev --ignore-scripts");
  });
});
