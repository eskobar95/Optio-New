import { describe, expect, it } from "vitest";
import {
  createEnvModelAdapter,
  createInstalledSkillLoader,
  DEFAULT_SKILL_BUDGET,
  readModelEnv,
  runAgentLoop,
  type ModelAdapter,
  type SkillLoader,
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

  it("resolves skills before the model adapter sees the prompt", async () => {
    const order: string[] = [];
    const loader: SkillLoader = {
      async resolve() {
        order.push("resolve");
        return [{ id: "bot-session", excerpt: "New Bot decides.", source: "skill" }];
      },
    };
    const adapter: ModelAdapter = {
      async complete(request) {
        order.push("complete");
        return { text: request.skills?.[0]?.excerpt ?? "" };
      },
    };

    const result = await runAgentLoop({ prompt: "plan the slice" }, adapter, loader);

    expect(order).toEqual(["resolve", "complete"]);
    expect(result).toEqual({ text: "New Bot decides." });
  });

  it("default loader attaches bot-session before the adapter runs", async () => {
    let seen = "";
    const adapter: ModelAdapter = {
      async complete(request) {
        seen = request.skills?.map((skill) => skill.id).join(",") ?? "";
        return { text: "ack: ready" };
      },
    };

    const result = await runAgentLoop({ prompt: "plan the slice" }, adapter);

    expect(seen).toBe("bot-session");
    expect(result).toEqual({ text: "ack: ready" });
  });
});

describe("installed skill budget", () => {
  const loader = createInstalledSkillLoader();

  it("loads bot-session from .cursor/skills and leaves caveman off", async () => {
    const skills = await loader.resolve({ prompt: "plan the slice" }, DEFAULT_SKILL_BUDGET);

    expect(skills.map((skill) => skill.id)).toEqual(["bot-session"]);
    expect(skills[0]?.source).toBe("skill");
    expect(skills[0]?.excerpt).toContain("name: bot-session");
    expect(skills[0]?.excerpt).toContain("No Linear API");
  });

  it("loads caveman only when opted in", async () => {
    const enabled = await loader.resolve(
      { prompt: "plan the slice", caveman: true },
      DEFAULT_SKILL_BUDGET,
    );
    expect(enabled.map((skill) => skill.id)).toEqual(["bot-session", "caveman"]);
    expect(enabled[1]?.excerpt).toContain("name: caveman");

    const disabled = await loader.resolve(
      { prompt: "plan the slice /caveman off", caveman: true },
      DEFAULT_SKILL_BUDGET,
    );
    expect(disabled.map((skill) => skill.id)).toEqual(["bot-session"]);
  });

  it("selects a kit skill and a specialist inside the budget", async () => {
    const skills = await loader.resolve(
      { prompt: "Use tdd on the backend API" },
      DEFAULT_SKILL_BUDGET,
    );

    expect(skills.map((skill) => skill.id)).toEqual(["bot-session", "backend", "tdd"]);
    expect(skills.map((skill) => skill.source)).toEqual(["skill", "specialist", "skill"]);
    const chars = skills.reduce((sum, skill) => sum + skill.excerpt.length, 0);
    expect(chars).toBeLessThanOrEqual(DEFAULT_SKILL_BUDGET.maxExcerptChars);
    expect(skills.some((skill) => skill.id.startsWith("caveman"))).toBe(false);
  });

  it("truncates excerpts to the shared character budget", async () => {
    const skills = await loader.resolve(
      { prompt: "plan the slice" },
      { maxSkills: 4, maxExcerptChars: 80 },
    );

    expect(skills).toHaveLength(1);
    expect(skills[0]?.excerpt.length).toBeLessThanOrEqual(80);
    expect(skills[0]?.excerpt.endsWith("…")).toBe(true);
  });
});

describe("env model adapter stub", () => {
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
