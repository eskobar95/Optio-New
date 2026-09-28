import { getTableColumns, getTableName, getTableUniqueName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { resolveDatabaseUrl } from "../src/db/client.js";
import {
  agentSkills,
  agents,
  flueSchema,
  optioSchema,
  sessions,
  skills,
  tenants,
  workflowAgents,
  workflows,
  workspaces,
} from "../src/db/schema/index.js";

describe("drizzle catalog schemas (ENG-24)", () => {
  it("exposes optio and flue pg schemas", () => {
    expect(optioSchema.schemaName).toBe("optio");
    expect(flueSchema.schemaName).toBe("flue");
  });

  it("places catalog tables under the expected schema and name", () => {
    const cases = [
      [tenants, "optio.tenants"],
      [workspaces, "optio.workspaces"],
      [agents, "optio.agents"],
      [skills, "optio.skills"],
      [workflows, "optio.workflows"],
      [agentSkills, "optio.agent_skills"],
      [workflowAgents, "optio.workflow_agents"],
      [sessions, "flue.sessions"],
    ] as const;

    for (const [table, unique] of cases) {
      const name = unique.slice(unique.indexOf(".") + 1);
      expect(getTableUniqueName(table)).toBe(unique);
      expect(getTableName(table)).toBe(name);
    }
  });

  it("keeps secret values out of column set (refs only)", () => {
    expect(Object.keys(getTableColumns(workspaces))).toContain("infisicalEnvSlug");
    expect(Object.keys(getTableColumns(workspaces))).not.toContain("token");
    expect(Object.keys(getTableColumns(agents))).toEqual(
      expect.arrayContaining(["kind", "instructionsRef", "enabled"]),
    );
  });

  it("resolves OPTIO_NEW_DATABASE_URL with local compose fallback", () => {
    expect(resolveDatabaseUrl({ OPTIO_NEW_DATABASE_URL: "postgresql://x/y" })).toBe(
      "postgresql://x/y",
    );
    expect(resolveDatabaseUrl({})).toBe("postgresql://optio:optio@127.0.0.1:5432/optio_new");
  });
});
