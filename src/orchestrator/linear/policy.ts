/**
 * Write policy for OPTIO_NEW_LINEAR_API_KEY.
 * Team allowlist is config/linear-projects.yaml (enabled keys only).
 * Phase 1 calls commentCreate (`queued`).
 * The workflow calls commentCreate for escalation and issueUpdate of stateId only.
 * issueCreate, issueDelete, and issueArchive stay forbidden.
 * Agent Sessions stay out of scope.
 */
import {
  enabledLinearTeam,
  type LinearProjectsConfig,
  type LinearTeamProject,
} from "./projects.js";

export {
  LinearProjectsConfigError,
  enabledLinearTeam,
  loadLinearProjectsConfig,
  type LinearProjectsConfig,
  type LinearTeamProject,
} from "./projects.js";

export const LINEAR_ALLOWED_WRITES = ["commentCreate", "issueUpdate"] as const;

export type LinearAllowedWrite = (typeof LINEAR_ALLOWED_WRITES)[number];

export const LINEAR_FORBIDDEN_WRITES = ["issueCreate", "issueDelete", "issueArchive"] as const;

const ISSUE_UPDATE_FIELDS = new Set(["stateId"]);

export function assertLinearWrite(operation: string, fields?: readonly string[]): void {
  if ((LINEAR_FORBIDDEN_WRITES as readonly string[]).includes(operation)) {
    throw new Error(`Linear API write ${operation} is not allowed`);
  }
  if (operation === "commentCreate") return;
  if (operation === "issueUpdate") {
    const used = fields ?? [];
    if (used.length !== 1 || !ISSUE_UPDATE_FIELDS.has(used[0] ?? "")) {
      throw new Error("Linear issueUpdate may set stateId only");
    }
    return;
  }
  throw new Error(`Linear API write ${operation} is not allowed`);
}

export function isLinearTeamEnabled(teamKey: string, projects: LinearProjectsConfig): boolean {
  return enabledLinearTeam(projects, teamKey) !== undefined;
}

/**
 * Env override wins when it is non-blank.
 * Otherwise the enabled team's defaultRepoId is used.
 * Blank means intake has no catalog repo.
 */
export function linearIntakeRepoId(
  team: Pick<LinearTeamProject, "defaultRepoId">,
  envOverride: string | undefined,
): string {
  const override = envOverride?.trim() ?? "";
  if (override) return override;
  return team.defaultRepoId?.trim() ?? "";
}
