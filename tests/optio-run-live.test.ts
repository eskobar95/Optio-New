import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createCodingAgent } from "../src/adapters/select.js";

// Opt-in and paid: the Factory's optio-run backend against the real Claude CLI and Jev.
// OPTIO_RUN_LIVE=1 OPTIO_RUN_DIST=/path/to/optio-ide/packages/optio-run/dist/index.js npx vitest run tests/optio-run-live.test.ts
const live = process.env.OPTIO_RUN_LIVE === "1" && Boolean(process.env.OPTIO_RUN_DIST);

describe.skipIf(!live)("optio-run backend, live", () => {
  it("writes a file in a worktree and leaves the push undone", async () => {
    const dir = "/tmp/optio-new-run-live";
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    execSync(
      "git init -q && echo '# demo' > README.md && git add . && git -c user.email=t@t -c user.name=t commit -qm init",
      { cwd: dir },
    );
    const mod = (await import(process.env.OPTIO_RUN_DIST as string)) as { runClaude: never };
    const agent = createCodingAgent("optio-run", { runClaude: mod.runClaude });
    const output = await agent.run({
      worktree_path: dir,
      prompt: "Create a file notes.txt containing the word hello. Do not commit or push.",
      allowed_tools: ["edit", "shell"],
      budget: { maxWallClockMs: 180_000 },
      metadata: {
        task_id: "t-live",
        worktree_id: "wt-live",
        workflow_id: "default-task",
        step_id: "implementation",
        agent_id: "agents/implementation",
        model_id: "haiku",
      },
    });
    console.log(
      "LIVE",
      JSON.stringify({
        status: output.status,
        pr_ready: output.pr_ready,
        diff: output.diff_summary,
        usage: output.usage,
        logs: output.logs?.slice(0, 200),
      }),
    );
    expect(output.status).toBe("succeeded");
    expect(existsSync(`${dir}/notes.txt`) && readFileSync(`${dir}/notes.txt`, "utf8").trim()).toBe(
      "hello",
    );
  }, 240_000);
});
