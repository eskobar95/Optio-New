import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_SKILL_BUDGET, createInstalledSkillLoader } from "../src/agent/skills.js";
import type { MetaIssuePublisher } from "../src/orchestrator/learning/publisher.js";
import {
  InMemoryLearningStore,
  InMemoryStepCursorStore,
  LEARNING_QUEUE,
  ReviewGateClosedError,
  createAgentStageHandler,
  createGithubMetaIssuePublisher,
  createQueueLearningSink,
  createSqlLearningStore,
  failureFingerprint,
  loadLearningsDdl,
  processLearningObservation,
  processStageJob,
  readLearningConfig,
  startLearningWorker,
  type LearningObservationInput,
  type LearningStore,
} from "../src/index.js";

const NOW = () => new Date("2026-09-26T00:00:00.000Z");

function failure(over: Partial<LearningObservationInput> = {}): LearningObservationInput {
  return {
    stepId: "implement",
    errorClass: "tests_failed",
    field: "billing",
    taskId: "task-1",
    sessionId: "s-1",
    source: "implementation",
    skillIds: ["tdd"],
    specialistIds: ["backend"],
    excerpt: "assertion failed",
    ...over,
  };
}

async function recordTimes(
  store: LearningStore,
  count: number,
  publisher?: MetaIssuePublisher,
  start = 0,
) {
  const results = [];
  for (let index = 0; index < count; index += 1) {
    const n = start + index + 1;
    results.push(
      await processLearningObservation(
        failure({
          taskId: `task-${n}`,
          sessionId: `s-${n}`,
          excerpt:
            index === count - 1
              ? "postgres://optio:secretpass@postgres:5432/db Bearer sk-abcdefghijklmnopqrstuvwxyz"
              : "assertion failed",
        }),
        { store, publisher, threshold: 3, windowDays: 14, now: NOW },
      ),
    );
  }
  return results;
}

describe("learning worker", () => {
  it("uses a configurable threshold and files one meta-issue with a budget proposal", async () => {
    expect(readLearningConfig({})).toEqual({ threshold: 3, windowDays: 14 });
    expect(
      readLearningConfig({ OPTIO_LEARN_THRESHOLD: "5", OPTIO_LEARN_WINDOW_DAYS: "7" }),
    ).toEqual({ threshold: 5, windowDays: 7 });
    expect(
      readLearningConfig({ OPTIO_LEARN_THRESHOLD: "0", OPTIO_LEARN_WINDOW_DAYS: "nope" }),
    ).toEqual({ threshold: 3, windowDays: 14 });

    const swapped = failureFingerprint({
      workflowId: "default-task",
      stepId: "implement",
      skillIds: ["b", "a"],
      specialistIds: ["z", "y"],
      errorClass: "tests_failed",
      field: "billing",
    });
    expect(swapped).toBe(
      failureFingerprint({
        workflowId: "default-task",
        stepId: "implement",
        skillIds: ["a", "b"],
        specialistIds: ["y", "z"],
        errorClass: "tests_failed",
        field: "billing",
      }),
    );
    expect(swapped).not.toBe(
      failureFingerprint({
        workflowId: "default-task",
        stepId: "implement",
        skillIds: ["a", "b"],
        specialistIds: [],
        errorClass: "tests_failed",
        field: "auth",
      }),
    );

    const requests: { url: string; body: string; authorization: string }[] = [];
    const publisher = createGithubMetaIssuePublisher({
      token: "test-token",
      owner: "eskobar95",
      repo: "Optio-New",
      fetchImpl: async (url, init) => {
        const headers = init?.headers as Record<string, string>;
        requests.push({
          url: String(url),
          body: String(init?.body ?? ""),
          authorization: headers.Authorization,
        });
        return new Response(
          JSON.stringify({ html_url: "https://github.com/eskobar95/Optio-New/issues/99" }),
          { status: 201 },
        );
      },
    });

    const store = new InMemoryLearningStore();
    const below = await recordTimes(store, 2, publisher);
    expect(below[1]?.status).toBe("observed");
    expect(below[1]?.proposalBody).toBeNull();
    expect(requests).toHaveLength(0);

    const opened = await recordTimes(store, 1, publisher, 2);
    expect(opened[0]).toMatchObject({
      status: "proposed",
      hitCount: 3,
      metaIssueUrl: "https://github.com/eskobar95/Optio-New/issues/99",
      rewroteProductionGates: false,
    });
    expect(opened[0]?.proposalBody).toContain(
      "Propose removing `tdd` from the `implement` budget for field `billing`.",
    );
    expect(opened[0]?.proposalBody).toContain("does not change production gates");
    expect(requests).toHaveLength(1);
    const filed = JSON.parse(requests[0]?.body ?? "{}") as {
      title: string;
      body: string;
      labels: string[];
    };
    expect(requests[0]?.url).toBe("https://api.github.com/repos/eskobar95/Optio-New/issues");
    expect(requests[0]?.authorization).toBe("Bearer test-token");
    expect(filed.title).toContain("[meta/self-improve]");
    expect(filed.labels).toEqual(["meta/self-improve"]);
    expect(filed.body).toContain("Hits: 3 within 14 days (threshold 3)");
    expect(filed.body).toContain("does not change production gates");

    await recordTimes(store, 1, publisher, 3);
    expect(requests).toHaveLength(1);

    const stored = await store.get(opened[0]!.fingerprint);
    expect(stored?.excerpt).not.toContain("secretpass");
    expect(stored?.excerpt).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(stored?.excerpt).toContain("redacted");
    expect(await store.listByField("billing", 8)).toHaveLength(1);
    expect(await store.listByField("auth", 8)).toHaveLength(0);
  });

  it("retries GitHub without labels when the meta label is missing", async () => {
    let calls = 0;
    const publisher = createGithubMetaIssuePublisher({
      token: "test-token",
      owner: "eskobar95",
      repo: "Optio-New",
      fetchImpl: async (_url, init) => {
        calls += 1;
        const body = JSON.parse(String(init?.body)) as { labels?: string[] };
        if (calls === 1) {
          expect(body.labels).toEqual(["meta/self-improve"]);
          return new Response("missing label", { status: 422 });
        }
        expect(body.labels).toBeUndefined();
        return new Response(
          JSON.stringify({ html_url: "https://github.com/eskobar95/Optio-New/issues/100" }),
          { status: 201 },
        );
      },
    });
    const filed = await publisher.publish({
      title: "[meta/self-improve] tests_failed",
      body: "Propose removing `tdd`.",
      labels: ["meta/self-improve"],
      fingerprint: "abc",
    });
    expect(filed).toEqual({
      filed: true,
      url: "https://github.com/eskobar95/Optio-New/issues/100",
    });
  });

  it("ignores failures outside the window and duplicate deliveries", async () => {
    const store = new InMemoryLearningStore();
    const publisher = {
      async publish() {
        throw new Error("should not file");
      },
    };
    for (let index = 0; index < 3; index += 1) {
      const result = await processLearningObservation(
        failure({
          sessionId: `old-${index}`,
          occurredAt: "2026-08-01T00:00:00.000Z",
        }),
        { store, publisher, threshold: 3, windowDays: 14, now: NOW },
      );
      expect(result).toMatchObject({
        status: "observed",
        hitCount: 0,
        rewroteProductionGates: false,
      });
    }
    const again = await processLearningObservation(failure(), {
      store,
      publisher,
      threshold: 3,
      windowDays: 14,
      now: NOW,
    });
    const duplicate = await processLearningObservation(failure(), {
      store,
      publisher,
      threshold: 3,
      windowDays: 14,
      now: NOW,
    });
    expect(again.hitCount).toBe(1);
    expect(duplicate.hitCount).toBe(1);
    expect(duplicate.status).toBe("observed");
  });

  it("round-trips the learnings table through the SQL store", async () => {
    const ddl = loadLearningsDdl();
    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS learnings");
    expect(ddl).toContain("field_tag");
    expect(ddl).toContain("proposal_body");
    expect(ddl).toContain("meta_issue_url");
    expect(ddl).toContain("status IN ('observed', 'proposed')");

    const rows = new Map<string, Record<string, unknown>>();
    const store = createSqlLearningStore({
      async query(sql, params = []) {
        if (sql.startsWith("INSERT")) {
          rows.set(String(params[0]), {
            fingerprint: params[0],
            workflow_id: params[1],
            step_id: params[2],
            skill_ids: params[3],
            specialist_ids: params[4],
            error_class: params[5],
            field_tag: params[6],
            occurrences: params[7],
            hit_count: String(params[8]),
            status: params[9],
            excerpt: params[10],
            sample_task_ids: params[11],
            proposal_body: params[12],
            meta_issue_url: params[13],
            updated_at: params[14],
          });
          return { rows: [] };
        }
        if (sql.includes("WHERE fingerprint")) {
          const row = rows.get(String(params[0]));
          return { rows: row ? [row] : [] };
        }
        if (sql.includes("WHERE field_tag")) {
          const matched = [...rows.values()].filter((row) => row.field_tag === params[0]);
          return { rows: matched.slice(0, Number(params[1])) };
        }
        throw new Error(`unexpected sql: ${sql}`);
      },
    });

    const opened = await recordTimes(store, 3);
    expect(opened[2]?.status).toBe("proposed");
    expect(opened[2]?.rewroteProductionGates).toBe(false);
    const listed = await store.listByField("billing", 5);
    expect(listed[0]?.hitCount).toBe(3);
    expect(listed[0]?.proposalBody).toContain("does not change production gates");
  });

  it("enqueues optio.learn and lets the worker fingerprint the payload", async () => {
    const jobs: { name: string; data: unknown }[] = [];
    const sink = createQueueLearningSink({
      async add(name, data) {
        jobs.push({ name, data });
      },
    });
    await sink.record(failure({ sessionId: "queued" }));
    expect(jobs).toEqual([{ name: "fingerprint", data: failure({ sessionId: "queued" }) }]);

    const store = new InMemoryLearningStore();
    let queueName = "";
    const handle = startLearningWorker(
      { store, threshold: 3, windowDays: 14, now: NOW },
      {
        create(name, processor) {
          queueName = name;
          return {
            async close() {
              await processor(jobs[0]?.data);
            },
          };
        },
      },
    );
    expect(queueName).toBe(LEARNING_QUEUE);
    await handle.close();
    const rows = await store.listByField("billing", 5);
    expect(rows[0]?.status).toBe("observed");
    expect(rows[0]?.hitCount).toBe(1);
  });

  it("records review-gate and implementation failures without blocking the gate", async () => {
    const seen: LearningObservationInput[] = [];
    async function readyCursor(): Promise<InMemoryStepCursorStore> {
      const cursors = new InMemoryStepCursorStore();
      await cursors.save({
        taskId: "t-1",
        sessionId: "s-1",
        stage: "review",
        nextStepIndex: 2,
        status: "completed",
        updatedAt: "2026-09-26T00:00:00.000Z",
      });
      return cursors;
    }

    await processStageJob(
      { taskId: "t-1", sessionId: "s-1", stage: "ready" },
      {
        cursors: await readyCursor(),
        reviewGate: {
          async loadEvidence() {
            return { tests_green: true, ci_status: "success" };
          },
        },
        learning: {
          async record(event) {
            seen.push(event);
          },
        },
        handler: { async run() {} },
      },
    );
    expect(seen).toEqual([]);

    await expect(
      processStageJob(
        { taskId: "t-1", sessionId: "s-1", stage: "ready" },
        {
          cursors: await readyCursor(),
          reviewGate: {
            async loadEvidence() {
              return {
                tests_green: false,
                ci_status: "failure",
                field: "billing",
                skill_ids: ["tdd"],
                review_notes: "postgres://optio:secretpass@db/optio",
              };
            },
          },
          learning: {
            async record() {
              throw new Error("db down");
            },
          },
          handler: {
            async run() {
              throw new Error("ready must not run");
            },
          },
        },
      ),
    ).rejects.toBeInstanceOf(ReviewGateClosedError);

    await expect(
      processStageJob(
        { taskId: "t-1", sessionId: "s-1", stage: "ready" },
        {
          cursors: await readyCursor(),
          reviewGate: {
            async loadEvidence() {
              return {
                tests_green: false,
                ci_status: "failure",
                attempt: 1,
                field: "billing",
                skill_ids: ["tdd"],
                review_notes: "postgres://optio:secretpass@db/optio",
              };
            },
          },
          learning: {
            async record(event) {
              seen.push(event);
            },
          },
          handler: {
            async run() {
              throw new Error("ready must not run");
            },
          },
        },
      ),
    ).rejects.toBeInstanceOf(ReviewGateClosedError);

    expect(seen[0]).toMatchObject({
      source: "review_gate",
      errorClass: "tests_failed",
      field: "billing",
      skillIds: ["tdd"],
      stepId: "review",
    });
    expect(seen[0]?.excerpt).not.toContain("secretpass");

    const plan = new InMemoryStepCursorStore();
    await plan.save({
      taskId: "t-1",
      sessionId: "s-1",
      stage: "plan",
      nextStepIndex: 2,
      status: "completed",
      updatedAt: "2026-09-26T00:00:00.000Z",
    });
    await expect(
      processStageJob(
        { taskId: "t-1", sessionId: "s-1", stage: "implement" },
        {
          cursors: plan,
          learning: {
            async record(event) {
              seen.push(event);
            },
          },
          learningContext: { field: "billing", skillIds: ["tdd"] },
          handler: {
            async run() {
              throw new Error("npm test failed sk-abcdefghijklmnopqrstuvwxyz");
            },
          },
        },
      ),
    ).rejects.toThrow(/npm test failed/);
    expect(seen[1]).toMatchObject({
      source: "implementation",
      errorClass: "handler_failed",
      field: "billing",
      stepId: "implement",
      skillIds: ["tdd"],
    });
    expect(seen[1]?.excerpt).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });

  it("injects learnings into the planner and deprioritizes repeated skills", async () => {
    const store = new InMemoryLearningStore();
    await recordTimes(store, 3);
    const prompts: string[] = [];
    let deprioritize: readonly string[] | undefined;
    const handler = createAgentStageHandler(
      {
        async complete(request) {
          prompts.push(request.prompt);
          return { text: "plan" };
        },
      },
      {
        learnings: {
          async listForPlan() {
            return store.listByField("billing", 8);
          },
        },
        skillLoader: {
          async resolve(_input, budget) {
            deprioritize = budget.deprioritizeIds;
            return [];
          },
        },
      },
    );
    await handler.run({
      taskId: "t-1",
      sessionId: "s-1",
      stage: "plan",
      step: "invoke_planner",
      stepIndex: 1,
    });
    expect(prompts[0]).toContain("do not change production gates");
    expect(prompts[0]).toContain("Propose removing `tdd`");
    expect(deprioritize).toEqual(["tdd"]);

    const root = await mkdtemp(join(tmpdir(), "optio-learn-"));
    try {
      await mkdir(join(root, ".cursor", "skills", "alpha"), { recursive: true });
      await mkdir(join(root, ".cursor", "skills", "beta"), { recursive: true });
      await mkdir(join(root, ".cursor", "agents"), { recursive: true });
      const body = (name: string) =>
        `---\nname: ${name}\ndescription: billing invoice payment reconciliation\n---\n${name}\n`;
      await writeFile(join(root, ".cursor", "skills", "alpha", "SKILL.md"), body("alpha"));
      await writeFile(join(root, ".cursor", "skills", "beta", "SKILL.md"), body("beta"));
      const loader = createInstalledSkillLoader({ root });
      const prompt = "billing invoice payment reconciliation";
      const budget = { ...DEFAULT_SKILL_BUDGET, allowedIds: ["alpha", "beta"] };
      const both = await loader.resolve(
        { prompt },
        {
          ...budget,
          deprioritizeIds: ["alpha", "beta"],
        },
      );
      expect(both.map((skill) => skill.id)).toEqual(["alpha", "beta"]);
      const preferred = await loader.resolve({ prompt }, { ...budget, deprioritizeIds: ["alpha"] });
      expect(preferred.map((skill) => skill.id)).toEqual(["beta"]);
      expect(budget.allowedIds).toEqual(["alpha", "beta"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ships a learn-profile compose service that does not install lifecycle scripts", () => {
    const compose = readFileSync("docker-compose.yml", "utf8");
    const start = compose.indexOf("\n  learning-worker:\n");
    expect(start).toBeGreaterThan(-1);
    const block = compose.slice(start, start + 900);
    expect(block).toContain('profiles: ["learn"]');
    expect(block).toContain("dockerfile: Dockerfile.learning-worker");
    expect(block).toContain("OPTIO_LEARN_THRESHOLD");
    const dockerfile = readFileSync("Dockerfile.learning-worker", "utf8");
    expect(dockerfile).toContain("npm ci --omit=dev --ignore-scripts");
    expect(dockerfile).toContain("002_learnings.sql");
  });
});
