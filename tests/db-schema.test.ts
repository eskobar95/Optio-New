import { getTableColumns, getTableName, getTableUniqueName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { resolveDatabaseUrl } from "../src/db/client.js";
import {
  agentConnections,
  agentSkills,
  agents,
  connections,
  flueSchema,
  optioSchema,
  sessions,
  skillPickLogs,
  skills,
  stageJevGates,
  tenants,
  transcriptEvents,
  transcripts,
  users,
  workflowAgents,
  workflowStages,
  workflows,
  workspaceMemberships,
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
      [users, "optio.users"],
      [workspaceMemberships, "optio.workspace_memberships"],
      [agents, "optio.agents"],
      [skills, "optio.skills"],
      [workflows, "optio.workflows"],
      [agentSkills, "optio.agent_skills"],
      [workflowAgents, "optio.workflow_agents"],
      [connections, "optio.connections"],
      [agentConnections, "optio.agent_connections"],
      [workflowStages, "optio.workflow_stages"],
      [stageJevGates, "optio.stage_jev_gates"],
      [transcripts, "optio.transcripts"],
      [transcriptEvents, "optio.transcript_events"],
      [skillPickLogs, "optio.skill_pick_logs"],
      [sessions, "flue.sessions"],
    ] as const;

    for (const [table, unique] of cases) {
      const name = unique.slice(unique.indexOf(".") + 1);
      expect(getTableUniqueName(table)).toBe(unique);
      expect(getTableName(table)).toBe(name);
    }
  });

  it("keeps connector secrets out of column set (Infisical refs only)", () => {
    const workspaceCols = Object.keys(getTableColumns(workspaces));
    expect(workspaceCols).toContain("infisicalEnvSlug");
    expect(workspaceCols).toContain("defaultCodingBackend");
    expect(workspaceCols).not.toContain("token");

    const connectionCols = Object.keys(getTableColumns(connections));
    expect(connectionCols).toContain("infisicalSecretPath");
    expect(connectionCols).not.toContain("token");
    expect(connectionCols).not.toContain("apiKey");

    const agentCols = Object.keys(getTableColumns(agents));
    expect(agentCols).toEqual(
      expect.arrayContaining([
        "kind",
        "instructionsRef",
        "model",
        "sandboxMode",
        "tools",
        "subagents",
        "enabled",
      ]),
    );
  });

  it("models append-only transcript events with compaction counters", () => {
    const cols = Object.keys(getTableColumns(transcriptEvents));
    expect(cols).toEqual(
      expect.arrayContaining(["seq", "content", "compacted", "compactedTokens", "cacheWrites"]),
    );
    expect(Object.keys(getTableColumns(stageJevGates))).toEqual(
      expect.arrayContaining(["gateKind", "timeoutMs", "passthroughOnTimeout"]),
    );
    expect(Object.keys(getTableColumns(sessions))).toEqual(
      expect.arrayContaining(["optioTranscriptId", "durableConversationId"]),
    );
  });

  it("resolves OPTIO_NEW_DATABASE_URL with local compose fallback", () => {
    expect(resolveDatabaseUrl({ OPTIO_NEW_DATABASE_URL: "postgresql://x/y" })).toBe(
      "postgresql://x/y",
    );
    expect(resolveDatabaseUrl({})).toBe("postgresql://optio:optio@127.0.0.1:5432/optio_new");
  });
});
