import { describe, expect, it } from "vitest";

import type { CodingAgentInput } from "../src/adapters/coding-agent.js";
import { createCodingAgent } from "../src/adapters/select.js";
import type { CliRunRequest, CliRunResult } from "../src/adapters/runtime.js";
import {
  CURSOR_IMPLEMENT_ACI_POLICY,
  DEFAULT_SEARCH_SUMMARY_LIMIT,
  EMPTY_COMMAND_OBSERVATION,
  MAX_SEARCH_SUMMARY_LIMIT,
  checkSyntax,
  cursorImplementPrompt,
  formatCommandObservation,
  gateFileEdit,
  summarizeSearch,
  type LintDiagnostic,
} from "../src/adapters/cursor/implement-feedback.js";

const BEFORE_JS = "export const n = 1;\n";
const VALID_JS = "export const n = 2;\n";
const INVALID_JS = "const = 1;\n";
const BEFORE_TS = "export const n: number = 1;\n";
const VALID_TS = "export const n: number = 2;\n";
const INVALID_TS = "export const n: number = ;\n";

function input(stepId: string): CodingAgentInput {
  return {
    worktree_path: "/tmp/wt-task",
    prompt: "implement the seam",
    instructions: "follow the spec",
    allowed_tools: ["edit", "shell"],
    budget: {},
    metadata: {
      task_id: "t-9",
      worktree_id: "wt-9",
      workflow_id: "default-task",
      step_id: stepId,
      agent_id: "agents/implementation",
    },
  };
}

describe("edit syntax gate", () => {
  it("accepts a JavaScript edit that parses", () => {
    const result = gateFileEdit({ path: "src/n.js", before: BEFORE_JS, after: VALID_JS });

    expect(result.blocked).toBe(false);
    expect(result.content).toBe(VALID_JS);
    expect(result.observation).toBe("Edit accepted for src/n.js.");
  });

  it("rolls a JavaScript syntax error back to the previous contents", () => {
    const result = gateFileEdit({ path: "src/n.js", before: BEFORE_JS, after: INVALID_JS });

    expect(result.blocked).toBe(true);
    expect(result.content).toBe(BEFORE_JS);
    expect(result.observation).toBe(
      "Edit blocked for src/n.js: syntax check failed. Change rolled back.\nL1: Unexpected token '='",
    );
  });

  it("accepts a TypeScript edit that parses", () => {
    const result = gateFileEdit({ path: "src/n.ts", before: BEFORE_TS, after: VALID_TS });

    expect(result.blocked).toBe(false);
    expect(result.content).toBe(VALID_TS);
    expect(result.observation).toBe("Edit accepted for src/n.ts.");
  });

  it("rolls a TypeScript syntax error back with a short diagnostic", () => {
    const diagnostics = checkSyntax(INVALID_TS, "src/n.ts");
    const result = gateFileEdit({ path: "src/n.ts", before: BEFORE_TS, after: INVALID_TS });

    expect(diagnostics).toEqual([{ line: 1, message: "Expression expected" }]);
    expect(result.blocked).toBe(true);
    expect(result.content).toBe(BEFORE_TS);
    expect(result.observation).toBe(
      "Edit blocked for src/n.ts: syntax check failed. Change rolled back.\nL1: Expression expected",
    );
    expect(result.observation.length).toBeLessThan(240);
  });

  it("keeps an import that names a missing module", () => {
    const after = 'import { missing } from "./missing.js";\nexport const n = missing;\n';
    const result = gateFileEdit({ path: "src/n.mjs", before: BEFORE_JS, after });

    expect(result.blocked).toBe(false);
    expect(result.content).toBe(after);
  });

  it("rolls a CommonJS syntax error back", () => {
    const result = gateFileEdit({
      path: "src/n.cjs",
      before: "module.exports = 1;\n",
      after: "module.exports = ;\n",
    });

    expect(result.blocked).toBe(true);
    expect(result.content).toBe("module.exports = 1;\n");
    expect(result.observation).toContain("L1: Unexpected token ';'");
  });

  it("does not syntax-check markdown or JSX as JavaScript", () => {
    const markdown = gateFileEdit({
      path: "README.md",
      before: "ok\n",
      after: INVALID_JS,
    });
    const tsx = gateFileEdit({
      path: "src/Button.tsx",
      before: "export const el = null;\n",
      after: "export const el = <div />;\n",
    });

    expect(markdown.blocked).toBe(false);
    expect(markdown.content).toBe(INVALID_JS);
    expect(tsx.blocked).toBe(false);
    expect(tsx.content).toBe("export const el = <div />;\n");
  });

  it("blocks on an injected lint failure and keeps the first five diagnostics", () => {
    const diagnostics: LintDiagnostic[] = [
      { line: 2, column: 4, message: "one" },
      { line: 3, message: "two" },
      { line: 4, message: "three" },
      { line: 5, message: "four" },
      { line: 6, message: "five" },
      { line: 7, message: "six" },
      { line: 8, message: "seven" },
    ];
    const result = gateFileEdit(
      { path: "src/a.ts", before: BEFORE_TS, after: VALID_TS },
      () => diagnostics,
    );

    expect(result.blocked).toBe(true);
    expect(result.content).toBe(BEFORE_TS);
    expect(result.observation).toBe(
      [
        "Edit blocked for src/a.ts: syntax check failed. Change rolled back.",
        "L2:C4: one",
        "L3: two",
        "L4: three",
        "L5: four",
        "L6: five",
        "(2 more)",
      ].join("\n"),
    );
    expect(result.observation).not.toContain("six");
  });

  it("blocks when the checker throws", () => {
    const result = gateFileEdit({ path: "src/a.js", before: BEFORE_JS, after: VALID_JS }, () => {
      throw new Error("lint crashed");
    });

    expect(result.blocked).toBe(true);
    expect(result.content).toBe(BEFORE_JS);
    expect(result.observation).toContain("lint crashed");
  });
});

describe("search and list summaries", () => {
  it("shows every match when the result fits the default window", () => {
    const summary = summarizeSearch({
      tool: "search",
      items: ["src/a.ts:1: alpha", "src/b.ts:2: beta"],
    });

    expect(DEFAULT_SEARCH_SUMMARY_LIMIT).toBe(20);
    expect(summary).toBe("Showing 2 matches.\nsrc/a.ts:1: alpha\nsrc/b.ts:2: beta");
  });

  it("truncates search results and names how many were omitted", () => {
    const items = Array.from({ length: 25 }, (_, index) => `src/f.ts:${index + 1}: hit ${index}`);
    const summary = summarizeSearch({ tool: "search", items });

    expect(summary.startsWith("Showing 20 of 25 matches.\n")).toBe(true);
    expect(summary).toContain("src/f.ts:1: hit 0");
    expect(summary).toContain("src/f.ts:20: hit 19");
    expect(summary).not.toContain("src/f.ts:21: hit 20");
    expect(summary.endsWith("(5 more omitted)")).toBe(true);
  });

  it("truncates list results with the same window", () => {
    const items = Array.from({ length: 3 }, (_, index) => `dir/item-${index}`);
    const summary = summarizeSearch({ tool: "list", items, limit: 1 });

    expect(summary).toBe("Showing 1 of 3 entries.\ndir/item-0\n(2 more omitted)");
  });

  it("reports an empty search or list without a dump", () => {
    expect(summarizeSearch({ tool: "search", items: [] })).toBe("No matches.");
    expect(summarizeSearch({ tool: "list", items: [] })).toBe("No entries.");
  });

  it("collapses a multi-line hit onto one capped line", () => {
    const summary = summarizeSearch({
      tool: "search",
      items: [`src/a.ts:1: ${"word ".repeat(80)}\nsecond line`],
    });
    const body = summary.split("\n")[1] ?? "";

    expect(body.startsWith("src/a.ts:1: word")).toBe(true);
    expect(body).not.toContain("\n");
    expect(body.endsWith("...")).toBe(true);
    expect(body.length).toBeLessThanOrEqual(160);
    expect(summary).not.toContain("second line");
  });

  it("caps a requested window at the summary maximum", () => {
    const items = Array.from({ length: 80 }, (_, index) => `item-${index}`);
    const summary = summarizeSearch({ tool: "list", items, limit: 10_000 });
    const shown = summary.split("\n").filter((line) => line.startsWith("item-"));

    expect(MAX_SEARCH_SUMMARY_LIMIT).toBe(50);
    expect(shown).toHaveLength(50);
    expect(summary).toContain("Showing 50 of 80 entries.");
    expect(summary.endsWith("(30 more omitted)")).toBe(true);
  });
});

describe("command observations", () => {
  it("names a successful command that printed nothing", () => {
    expect(EMPTY_COMMAND_OBSERVATION).toBe("Command succeeded with no output.");
    expect(formatCommandObservation({ exitCode: 0, stdout: "" })).toBe(EMPTY_COMMAND_OBSERVATION);
    expect(formatCommandObservation({ exitCode: 0, stdout: " \n\t", stderr: "" })).toBe(
      EMPTY_COMMAND_OBSERVATION,
    );
  });

  it("keeps stdout when the command printed something", () => {
    expect(formatCommandObservation({ exitCode: 0, stdout: "hello\n" })).toBe("hello\n");
  });

  it("keeps a stderr warning after the empty-stdout success line", () => {
    expect(formatCommandObservation({ exitCode: 0, stdout: "", stderr: "warn\n" })).toBe(
      `${EMPTY_COMMAND_OBSERVATION}\nwarn`,
    );
  });

  it("does not call a failed or unfinished command a success", () => {
    expect(formatCommandObservation({ exitCode: 1, stdout: "", stderr: "" })).toBe(
      "Command failed (exit 1).",
    );
    expect(formatCommandObservation({ exitCode: 2, stdout: "nope", stderr: "bad" })).toBe(
      "Command failed (exit 2).\nnope\nbad",
    );
    expect(formatCommandObservation({ exitCode: null, stdout: "" })).toBe(
      "Command finished with no output.",
    );
    expect(formatCommandObservation({ exitCode: 1, stdout: "" })).not.toContain(
      EMPTY_COMMAND_OBSERVATION,
    );
  });
});

describe("Cursor implement prompt policy", () => {
  it("appends the policy on implementation steps only", () => {
    const task = "follow the spec\n\nimplement the seam";
    const implementation = cursorImplementPrompt(input("implementation"));
    const invoke = cursorImplementPrompt(input("invoke_implementation"));
    const review = cursorImplementPrompt(input("invoke_review"));
    const record = cursorImplementPrompt(input("record_diff"));

    expect(implementation).toBe(`${task}\n\n${CURSOR_IMPLEMENT_ACI_POLICY}`);
    expect(invoke).toBe(`${task}\n\n${CURSOR_IMPLEMENT_ACI_POLICY}`);
    expect(review).toBe(task);
    expect(record).toBe(task);
    expect(CURSOR_IMPLEMENT_ACI_POLICY).toContain("https://api2.cursor.sh");
    expect(CURSOR_IMPLEMENT_ACI_POLICY).toContain(EMPTY_COMMAND_OBSERVATION);
    expect(CURSOR_IMPLEMENT_ACI_POLICY).toContain("rolled back");
    expect(CURSOR_IMPLEMENT_ACI_POLICY).toContain("omitted");
  });

  it("puts that policy on the Cursor CLI prompt for invoke_implementation", async () => {
    const calls: CliRunRequest[] = [];
    const agent = createCodingAgent("cursor", {
      env: { CURSOR_API_KEY: "cursor-key" },
      runner: async (request: CliRunRequest): Promise<CliRunResult> => {
        calls.push(request);
        return {
          exitCode: 0,
          stdout: JSON.stringify({ type: "result", is_error: false }),
          stderr: "",
          timedOut: false,
          signal: null,
        };
      },
    });

    await agent.run(input("invoke_implementation"));
    await agent.run(input("invoke_review"));

    expect(calls[0]?.args.at(-1)).toBe(
      `follow the spec\n\nimplement the seam\n\n${CURSOR_IMPLEMENT_ACI_POLICY}`,
    );
    expect(calls[1]?.args.at(-1)).toBe("follow the spec\n\nimplement the seam");
    expect(calls[0]?.env.CURSOR_API_ENDPOINT).toBe("https://api2.cursor.sh");
  });
});
