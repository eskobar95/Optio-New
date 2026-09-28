import { getTableColumns, getTableName, getTableUniqueName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { DEFAULT_LOCAL_DATABASE_URL, resolveDatabaseUrl } from "../src/db/database-url.js";
import { resolveMigrationsFolder } from "../src/db/migrate-cli.js";
import {
  agentConnections,
  agentMcpTools,
  agentSkills,
  agentSubagents,
  agents,
  codingBackendEnum,
  connectionKindEnum,
  connections,
  flueSchema,
  jevGateKindEnum,
  mcpTools,
  optioSchema,
  sessions,
  skillMcpTools,
  skillPickLogs,
  skills,
  stageJevGates,
  tenants,
  transcriptEvents,
  transcripts,
  users,
  workflowAgents,
  workflowConnections,
  workflowStageTypeEnum,
  workflowStages,
  workflows,
  workspaceMemberships,
  workspaces,
} from "../src/db/schema/index.js";

describe("drizzle catalog schemas (ENG-24 / ENG-35)", () => {
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
      [agentSubagents, "optio.agent_subagents"],
      [workflowAgents, "optio.workflow_agents"],
      [connections, "optio.connections"],
      [agentConnections, "optio.agent_connections"],
      [workflowConnections, "optio.workflow_connections"],
      [mcpTools, "optio.mcp_tools"],
      [agentMcpTools, "optio.agent_mcp_tools"],
      [skillMcpTools, "optio.skill_mcp_tools"],
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
        "description",
        "instructionsRef",
        "configRef",
        "model",
        "sandboxMode",
        "tools",
        "subagents",
        "lazyLoadBody",
        "enabled",
      ]),
    );

    const skillCols = Object.keys(getTableColumns(skills));
    expect(skillCols).toEqual(
      expect.arrayContaining(["bodyRef", "folderRef", "configRef", "lazyLoadBody", "description"]),
    );

    const mcpCols = Object.keys(getTableColumns(mcpTools));
    expect(mcpCols).toEqual(
      expect.arrayContaining(["name", "slug", "description", "endpoint", "enabled"]),
    );
    expect(mcpCols).not.toContain("infisicalSecretPath");
    expect(mcpCols).not.toContain("token");
  });

  it("models ordered workflow stages with type/config and integration refs", () => {
    const stageCols = Object.keys(getTableColumns(workflowStages));
    expect(stageCols).toEqual(
      expect.arrayContaining(["sortOrder", "stageType", "config", "agentId", "connectionId"]),
    );
    expect(workflowStageTypeEnum.enumValues).toEqual([
      "agent",
      "custom_agent",
      "gate",
      "aggregator",
      "branch",
      "integration",
    ]);
  });

  it("models append-only transcript events with compaction counters", () => {
    const cols = Object.keys(getTableColumns(transcriptEvents));
    expect(cols).toEqual(
      expect.arrayContaining(["seq", "content", "compacted", "compactedTokens", "cacheWrites"]),
    );
    expect(Object.keys(getTableColumns(stageJevGates))).toEqual(
      expect.arrayContaining(["gateKind", "timeoutMs", "passthroughOnTimeout"]),
    );
    const sessionCols = Object.keys(getTableColumns(sessions));
    expect(sessionCols).toContain("durableConversationId");
    expect(sessionCols).not.toContain("optioTranscriptId");
    expect(Object.keys(getTableColumns(skillPickLogs))).toContain("agentId");
  });

  it("exposes closed enums for backend, connection, sandbox, and jev gates", () => {
    expect(codingBackendEnum.enumValues).toEqual(["cursor-cli", "flue", "codex"]);
    expect(connectionKindEnum.enumValues).toEqual(["github", "linear", "slack", "mcp"]);
    expect(jevGateKindEnum.enumValues).toEqual([
      "backend_cascade",
      "plan",
      "skill_pick",
      "review_prescreen",
      "intake",
    ]);
  });

  it("resolves OPTIO_NEW_DATABASE_URL with Compose-aligned fallback", () => {
    expect(resolveDatabaseUrl({ OPTIO_NEW_DATABASE_URL: "postgresql://x/y" })).toBe(
      "postgresql://x/y",
    );
    expect(resolveDatabaseUrl({})).toBe(DEFAULT_LOCAL_DATABASE_URL);
    expect(DEFAULT_LOCAL_DATABASE_URL).toContain(":changeme@");
  });

  it("resolves drizzle migrations folder from repo root", () => {
    expect(resolveMigrationsFolder()).toMatch(/drizzle$/);
  });
});
