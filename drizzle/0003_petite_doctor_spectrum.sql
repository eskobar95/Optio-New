CREATE TYPE "optio"."workflow_stage_type" AS ENUM('agent', 'custom_agent', 'gate', 'aggregator', 'branch', 'integration');--> statement-breakpoint
CREATE TABLE "optio"."agent_mcp_tools" (
	"agent_id" uuid NOT NULL,
	"mcp_tool_id" uuid NOT NULL,
	CONSTRAINT "agent_mcp_tools_pkey" PRIMARY KEY("agent_id","mcp_tool_id")
);
--> statement-breakpoint
CREATE TABLE "optio"."agent_subagents" (
	"agent_id" uuid NOT NULL,
	"subagent_id" uuid NOT NULL,
	CONSTRAINT "agent_subagents_pkey" PRIMARY KEY("agent_id","subagent_id")
);
--> statement-breakpoint
CREATE TABLE "optio"."mcp_tools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"endpoint" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_tools_workspace_id_slug_unique" UNIQUE("workspace_id","slug")
);
--> statement-breakpoint
CREATE TABLE "optio"."skill_mcp_tools" (
	"skill_id" uuid NOT NULL,
	"mcp_tool_id" uuid NOT NULL,
	CONSTRAINT "skill_mcp_tools_pkey" PRIMARY KEY("skill_id","mcp_tool_id")
);
--> statement-breakpoint
CREATE TABLE "optio"."workflow_connections" (
	"workflow_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	CONSTRAINT "workflow_connections_pkey" PRIMARY KEY("workflow_id","connection_id")
);
--> statement-breakpoint
ALTER TABLE "optio"."agents" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "optio"."agents" ADD COLUMN "config_ref" text;--> statement-breakpoint
ALTER TABLE "optio"."agents" ADD COLUMN "lazy_load_body" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "optio"."skills" ADD COLUMN "folder_ref" text;--> statement-breakpoint
ALTER TABLE "optio"."skills" ADD COLUMN "config_ref" text;--> statement-breakpoint
ALTER TABLE "optio"."skills" ADD COLUMN "lazy_load_body" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "optio"."workflow_stages" ADD COLUMN "stage_type" "optio"."workflow_stage_type" DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "optio"."workflow_stages" ADD COLUMN "config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "optio"."workflow_stages" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "optio"."agent_mcp_tools" ADD CONSTRAINT "agent_mcp_tools_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "optio"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."agent_mcp_tools" ADD CONSTRAINT "agent_mcp_tools_mcp_tool_id_mcp_tools_id_fk" FOREIGN KEY ("mcp_tool_id") REFERENCES "optio"."mcp_tools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."agent_subagents" ADD CONSTRAINT "agent_subagents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "optio"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."agent_subagents" ADD CONSTRAINT "agent_subagents_subagent_id_agents_id_fk" FOREIGN KEY ("subagent_id") REFERENCES "optio"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."mcp_tools" ADD CONSTRAINT "mcp_tools_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "optio"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."skill_mcp_tools" ADD CONSTRAINT "skill_mcp_tools_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "optio"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."skill_mcp_tools" ADD CONSTRAINT "skill_mcp_tools_mcp_tool_id_mcp_tools_id_fk" FOREIGN KEY ("mcp_tool_id") REFERENCES "optio"."mcp_tools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."workflow_connections" ADD CONSTRAINT "workflow_connections_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "optio"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."workflow_connections" ADD CONSTRAINT "workflow_connections_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "optio"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."workflow_stages" ADD CONSTRAINT "workflow_stages_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "optio"."connections"("id") ON DELETE set null ON UPDATE no action;