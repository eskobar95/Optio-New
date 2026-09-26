import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function activeModelNames(yaml: string): string[] {
  return [...yaml.matchAll(/^\s*-\s*model_name:\s*(\S+)\s*$/gm)].map((match) => match[1] ?? "");
}

describe("LiteLLM example config", () => {
  const yaml = readFileSync("gateway/litellm/config.yaml.example", "utf8");
  const compose = readFileSync("docker-compose.yml", "utf8");

  it("lists the example models the Hop 2 router forwards to", () => {
    expect(activeModelNames(yaml)).toEqual(["gpt-4o", "claude-sonnet", "cache-exact"]);
  });

  it("reads provider keys from the environment and enables an exact cache", () => {
    expect(yaml).toContain("api_key: os.environ/OPENAI_API_KEY");
    expect(yaml).toContain("api_key: os.environ/ANTHROPIC_API_KEY");
    expect(yaml).toContain("master_key: os.environ/LITELLM_MASTER_KEY");
    expect(yaml).toContain("type: local");
    expect(yaml).not.toMatch(/sk-[a-zA-Z0-9]{8,}/);
  });

  it("is the file Compose mounts, with a loopback healthcheck", () => {
    expect(compose).toContain("./gateway/litellm/config.yaml.example:/app/config.yaml:ro");
    expect(compose).toContain("127.0.0.1:${OPTIO_NEW_LITELLM_HOST_PORT:-4000}:4000");
    expect(compose).toContain("/health/liveliness");
  });
});
