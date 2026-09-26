import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LINEAR_WEBHOOK_PATH,
  handleLinearWebhook,
  signLinearBody,
} from "../src/orchestrator/intake/adapters/linear.js";
import {
  isLinearTeamEnabled,
  linearIntakeRepoId,
  loadLinearProjectsConfig,
  LinearProjectsConfigError,
} from "../src/orchestrator/linear/policy.js";
import { resolveLinearProjectsConfigPath } from "../src/orchestrator/linear/projects.js";
import type { RepoCatalog } from "../src/orchestrator/repos/catalog.js";

const SECRET = "linear-webhook-test-secret";
const ISSUE_ID = "2174add1-f7c8-44e3-bbf3-2d60b5ea8bc9";

const catalog: RepoCatalog = {
  defaultRepoId: "optio-new",
  repos: [
    {
      repoId: "findjobabroad",
      cloneUrl: "https://github.com/kit/find-job-abroad.git",
      localPath: "/opt/findjobabroad",
      defaultBranch: "main",
      worktreeRoot: "/wt/fja",
    },
    {
      repoId: "workplace",
      cloneUrl: "https://github.com/KitCollective/workplace.git",
      localPath: "/opt/workplace",
      defaultBranch: "main",
      worktreeRoot: "/wt/workplace",
    },
  ],
};

function writeConfig(body: string): { dir: string; filePath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "linear-projects-"));
  const filePath = path.join(dir, "linear-projects.yaml");
  writeFileSync(filePath, body);
  return { dir, filePath };
}

function statusChange(team: string, identifier: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      action: "update",
      type: "Issue",
      webhookTimestamp: Date.now(),
      data: {
        id: ISSUE_ID,
        identifier,
        title: "Ship intake",
        team: { key: team },
      },
      updatedFrom: { stateId: "previous-state" },
    }),
  );
}

function webhook(raw: Buffer, extra?: { defaultRepoId?: string; env?: NodeJS.ProcessEnv }) {
  return handleLinearWebhook({
    raw,
    headers: { "linear-signature": signLinearBody(SECRET, raw) },
    secret: SECRET,
    catalog,
    defaultRepoId: extra?.defaultRepoId,
    apiKeyConfigured: true,
    env: extra?.env ?? {},
  });
}

describe("Linear projects config", () => {
  const errors: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
    errors.push(String(line));
  });

  afterEach(() => {
    errors.length = 0;
    spy.mockClear();
  });

  it("loads ENG as enabled and keeps FIN disabled", () => {
    const projects = loadLinearProjectsConfig({ env: {} });
    expect(projects.teams.map((team) => team.key)).toEqual(["ENG", "FIN"]);
    expect(isLinearTeamEnabled("ENG", projects)).toBe(true);
    expect(isLinearTeamEnabled("FIN", projects)).toBe(false);
    expect(isLinearTeamEnabled("KIT", projects)).toBe(false);
    const eng = projects.teams.find((team) => team.key === "ENG");
    expect(eng).toMatchObject({
      name: "Engineering",
      enabled: true,
      defaultRepoId: "findjobabroad",
      webhookPath: "/webhooks/linear",
    });
    expect(LINEAR_WEBHOOK_PATH).toBe("/webhooks/linear");
  });

  it("lets the env repo override win over the team default", () => {
    const team = { defaultRepoId: "findjobabroad" };
    expect(linearIntakeRepoId(team, undefined)).toBe("findjobabroad");
    expect(linearIntakeRepoId(team, "  ")).toBe("findjobabroad");
    expect(linearIntakeRepoId(team, "workplace")).toBe("workplace");
    expect(linearIntakeRepoId({}, undefined)).toBe("");
  });

  it("resolves OPTIO_NEW_LINEAR_PROJECTS_CONFIG and keeps extra team settings", () => {
    const { dir, filePath } = writeConfig(`teams:
  - key: ENG
    name: Engineering
    enabled: true
    defaultRepoId: findjobabroad
    webhookPath: /webhooks/linear
    linearProjectId: proj-eng
    settings:
      board: engineering
`);
    const relative = loadLinearProjectsConfig({
      cwd: dir,
      env: { OPTIO_NEW_LINEAR_PROJECTS_CONFIG: "linear-projects.yaml" },
    });
    expect(
      resolveLinearProjectsConfigPath(
        { OPTIO_NEW_LINEAR_PROJECTS_CONFIG: "linear-projects.yaml" },
        dir,
      ),
    ).toBe(filePath);
    const eng = relative.teams[0];
    expect(eng).toMatchObject({
      key: "ENG",
      linearProjectId: "proj-eng",
      settings: { board: "engineering" },
    });
  });

  it("fails closed when the file is missing, invalid, or has a duplicate key", () => {
    const logs: string[] = [];
    const log = (line: string) => {
      logs.push(line);
    };
    expect(() =>
      loadLinearProjectsConfig({
        env: {
          OPTIO_NEW_LINEAR_PROJECTS_CONFIG: path.join(tmpdir(), "missing-linear-projects.yaml"),
        },
        log,
      }),
    ).toThrow(LinearProjectsConfigError);
    expect(logs.at(-1)).toContain("linear projects config rejected");
    expect(logs.at(-1)).toContain("missing or unreadable");

    const invalid = writeConfig("teams: [not-a-team]\n");
    expect(() =>
      loadLinearProjectsConfig({
        env: { OPTIO_NEW_LINEAR_PROJECTS_CONFIG: invalid.filePath },
        log,
      }),
    ).toThrow(/invalid/);

    const duplicate = writeConfig(`teams:
  - key: ENG
    enabled: true
    defaultRepoId: findjobabroad
  - key: ENG
    enabled: false
`);
    expect(() =>
      loadLinearProjectsConfig({
        env: { OPTIO_NEW_LINEAR_PROJECTS_CONFIG: duplicate.filePath },
        log,
      }),
    ).toThrow(/duplicate team key ENG/);
    expect(logs.some((line) => line.includes("duplicate team key ENG"))).toBe(true);
  });

  it("accepts ENG, ignores FIN and unknown keys, and uses the config repo", () => {
    const accepted = webhook(statusChange("ENG", "ENG-12"));
    expect(accepted).toMatchObject({
      action: "enqueue",
      intake: { taskId: "lin-ENG-12", repoId: "findjobabroad", source: "linear" },
    });

    const fromIdentifier = Buffer.from(
      JSON.stringify({
        action: "update",
        type: "Issue",
        webhookTimestamp: Date.now(),
        data: { id: ISSUE_ID, identifier: "ENG-9", title: "Prefix" },
        updatedFrom: { stateId: "previous-state" },
      }),
    );
    expect(webhook(fromIdentifier)).toMatchObject({
      action: "enqueue",
      intake: { taskId: "lin-ENG-9", repoId: "findjobabroad" },
    });

    expect(webhook(statusChange("FIN", "FIN-12"))).toMatchObject({
      action: "respond",
      status: 200,
      body: { accepted: false, reason: "ignored" },
    });
    expect(webhook(statusChange("KIT", "KIT-1"))).toMatchObject({
      action: "respond",
      status: 200,
      body: { accepted: false, reason: "ignored" },
    });

    expect(webhook(statusChange("ENG", "ENG-12"), { defaultRepoId: "workplace" })).toMatchObject({
      action: "enqueue",
      intake: { repoId: "workplace" },
    });
  });

  it("returns 503 and does not enqueue when the config file cannot be loaded", () => {
    const missing = path.join(tmpdir(), "optio-missing-linear-projects.yaml");
    const result = webhook(statusChange("ENG", "ENG-12"), {
      env: { OPTIO_NEW_LINEAR_PROJECTS_CONFIG: missing },
    });
    expect(result).toMatchObject({
      action: "respond",
      status: 503,
      body: { error: "linear_projects_unconfigured" },
    });
    expect(errors.some((line) => line.includes("linear projects config rejected"))).toBe(true);
    expect(errors.join("\n")).not.toContain(SECRET);
  });

  it("returns 503 when the enabled team and the env override have no repo id", () => {
    const { filePath } = writeConfig(`teams:
  - key: ENG
    enabled: true
`);
    const result = webhook(statusChange("ENG", "ENG-4"), {
      env: { OPTIO_NEW_LINEAR_PROJECTS_CONFIG: filePath },
    });
    expect(result).toMatchObject({
      action: "respond",
      status: 503,
      body: { error: "linear_repo_unconfigured" },
    });
  });
});
