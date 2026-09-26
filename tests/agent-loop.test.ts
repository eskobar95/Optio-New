import { describe, expect, it } from "vitest";
import {
  createEnvModelAdapter,
  readModelEnv,
  runAgentLoop,
  type ModelAdapter,
} from "../src/index.js";

describe("request-response agent loop", () => {
  it("returns the model response for the prompt it sent", async () => {
    const seen: string[] = [];
    const adapter: ModelAdapter = {
      async complete(request) {
        seen.push(request.prompt);
        return { text: "ack: ready" };
      },
    };

    const result = await runAgentLoop({ prompt: "plan the slice" }, adapter);

    expect(seen).toEqual(["plan the slice"]);
    expect(result).toEqual({ text: "ack: ready" });
  });

  it("reads MODEL_API_KEY and MODEL_ENDPOINT without calling the network", async () => {
    expect(
      readModelEnv({
        MODEL_API_KEY: "sk-test",
        MODEL_ENDPOINT: "https://models.example/v1",
      }),
    ).toEqual({
      apiKey: "sk-test",
      endpoint: "https://models.example/v1",
    });

    const adapter = createEnvModelAdapter({
      MODEL_API_KEY: "sk-test",
      MODEL_ENDPOINT: "https://models.example/v1",
    });

    await expect(adapter.complete({ prompt: "ping" })).rejects.toThrow(/does not perform HTTP/);
  });
});
