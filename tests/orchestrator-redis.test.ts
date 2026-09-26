import { describe, expect, it } from "vitest";
import { readOrchestratorPort, redisConnectionOptions } from "../src/orchestrator/redis.js";

describe("orchestrator redis settings", () => {
  it("parses the Compose Redis URL", () => {
    expect(redisConnectionOptions("redis://redis:6379")).toEqual({
      host: "redis",
      port: 6379,
      maxRetriesPerRequest: null,
    });
  });

  it("reads a database index from the URL path", () => {
    expect(redisConnectionOptions("redis://redis:6379/2")).toMatchObject({
      host: "redis",
      port: 6379,
      db: 2,
    });
  });

  it("defaults the listen port to 3100", () => {
    expect(readOrchestratorPort(undefined)).toBe(3100);
    expect(readOrchestratorPort("3100")).toBe(3100);
    expect(() => readOrchestratorPort("0")).toThrow(/ORCHESTRATOR_PORT/);
  });
});
