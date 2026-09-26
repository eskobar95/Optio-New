/**
 * Team allowlist for Linear status-change intake.
 * The file is config/linear-projects.yaml unless OPTIO_NEW_LINEAR_PROJECTS_CONFIG is set.
 * A missing or invalid file fails closed: no team is accepted.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { logStageEvent } from "../jobs/stage-log.js";
import { REPO_ID_PATTERN } from "../repos/catalog.js";

export const LINEAR_PROJECTS_CONFIG_ENV = "OPTIO_NEW_LINEAR_PROJECTS_CONFIG";

/** Repo-relative path used when the env override is unset. */
export const DEFAULT_LINEAR_PROJECTS_RELATIVE_PATH = path.join("config", "linear-projects.yaml");

const TEAM_KEY_PATTERN = /^[A-Z][A-Z0-9]+$/;

const TeamSchema = z
  .object({
    key: z.string().regex(TEAM_KEY_PATTERN, "team key must look like ENG"),
    name: z.string().min(1).optional(),
    enabled: z.boolean(),
    defaultRepoId: z
      .string()
      .regex(REPO_ID_PATTERN, "defaultRepoId must be a safe catalog token")
      .optional(),
    webhookPath: z.string().min(1).optional(),
    notes: z.string().optional(),
    settings: z.record(z.unknown()).optional(),
  })
  .passthrough();

const FileSchema = z
  .object({
    teams: z.array(TeamSchema),
  })
  .passthrough();

export type LinearTeamProject = z.infer<typeof TeamSchema>;

export type LinearProjectsConfig = z.infer<typeof FileSchema>;

export class LinearProjectsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinearProjectsConfigError";
  }
}

export function resolveLinearProjectsConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const override = env[LINEAR_PROJECTS_CONFIG_ENV]?.trim() ?? "";
  if (override) return path.resolve(cwd, override);
  return path.join(cwd, DEFAULT_LINEAR_PROJECTS_RELATIVE_PATH);
}

function rejectConfig(message: string, log?: (line: string) => void): never {
  logStageEvent({ msg: "linear projects config rejected", error: message }, log ?? console.error);
  throw new LinearProjectsConfigError(message);
}

export function loadLinearProjectsConfig(
  options: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    log?: (line: string) => void;
  } = {},
): LinearProjectsConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const filePath = resolveLinearProjectsConfigPath(env, cwd);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unreadable";
    return rejectConfig(
      `Linear projects config is missing or unreadable (${filePath}): ${detail}`,
      options.log,
    );
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid YAML";
    return rejectConfig(
      `Linear projects config is invalid YAML (${filePath}): ${detail}`,
      options.log,
    );
  }

  const result = FileSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "file"}: ${issue.message}`)
      .join("; ");
    return rejectConfig(`Linear projects config is invalid (${filePath}): ${detail}`, options.log);
  }

  const seen = new Set<string>();
  for (const team of result.data.teams) {
    if (seen.has(team.key)) {
      return rejectConfig(
        `Linear projects config has a duplicate team key ${team.key} (${filePath})`,
        options.log,
      );
    }
    seen.add(team.key);
  }
  return result.data;
}

/** Enabled entry for this Linear team key, if the allowlist includes it. */
export function enabledLinearTeam(
  projects: LinearProjectsConfig,
  teamKey: string,
): LinearTeamProject | undefined {
  const key = teamKey.trim();
  return projects.teams.find((team) => team.enabled && team.key === key);
}
