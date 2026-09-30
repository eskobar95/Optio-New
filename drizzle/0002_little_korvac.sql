CREATE SCHEMA IF NOT EXISTS "optio";
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS "flue";
--> statement-breakpoint
CREATE TYPE "optio"."coding_backend" AS ENUM('cursor-cli', 'flue', 'codex');--> statement-breakpoint
CREATE TYPE "optio"."connection_kind" AS ENUM('github', 'linear', 'slack', 'mcp');--> statement-breakpoint
CREATE TYPE "optio"."jev_gate_kind" AS ENUM('backend_cascade', 'plan', 'skill_pick', 'review_prescreen', 'intake');--> statement-breakpoint
CREATE TYPE "optio"."sandbox_mode" AS ENUM('local');--> statement-breakpoint
ALTER TABLE "optio"."agent_connections" DROP CONSTRAINT "agent_connections_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "optio"."agent_connections" DROP CONSTRAINT "agent_connections_connection_id_connections_id_fk";
--> statement-breakpoint
ALTER TABLE "optio"."agent_skills" DROP CONSTRAINT "agent_skills_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "optio"."agent_skills" DROP CONSTRAINT "agent_skills_skill_id_skills_id_fk";
--> statement-breakpoint
ALTER TABLE "optio"."agents" DROP CONSTRAINT "agents_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "optio"."connections" DROP CONSTRAINT "connections_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "optio"."skill_pick_logs" DROP CONSTRAINT "skill_pick_logs_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "optio"."skills" DROP CONSTRAINT "skills_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "optio"."stage_jev_gates" DROP CONSTRAINT "stage_jev_gates_workflow_stage_id_workflow_stages_id_fk";
--> statement-breakpoint
ALTER TABLE "optio"."transcript_events" DROP CONSTRAINT "transcript_events_transcript_id_transcripts_id_fk";
--> statement-breakpoint
ALTER TABLE "optio"."transcripts" DROP CONSTRAINT "transcripts_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "optio"."users" DROP CONSTRAINT "users_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "optio"."workflow_agents" DROP CONSTRAINT "workflow_agents_workflow_id_workflows_id_fk";
--> statement-breakpoint
ALTER TABLE "optio"."workflow_agents" DROP CONSTRAINT "workflow_agents_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "optio"."workflow_stages" DROP CONSTRAINT "workflow_stages_workflow_id_workflows_id_fk";
--> statement-breakpoint
ALTER TABLE "optio"."workflow_stages" DROP CONSTRAINT "workflow_stages_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "optio"."workflows" DROP CONSTRAINT "workflows_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "optio"."workspace_memberships" DROP CONSTRAINT "workspace_memberships_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "optio"."workspace_memberships" DROP CONSTRAINT "workspace_memberships_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "optio"."workspaces" DROP CONSTRAINT "workspaces_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "optio"."agents" ALTER COLUMN "sandbox_mode" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "optio"."agents" ALTER COLUMN "sandbox_mode" SET DATA TYPE "optio"."sandbox_mode" USING "sandbox_mode"::"optio"."sandbox_mode";--> statement-breakpoint
ALTER TABLE "optio"."agents" ALTER COLUMN "sandbox_mode" SET DEFAULT 'local'::"optio"."sandbox_mode";--> statement-breakpoint
ALTER TABLE "optio"."connections" ALTER COLUMN "kind" SET DATA TYPE "optio"."connection_kind" USING "kind"::"optio"."connection_kind";--> statement-breakpoint
ALTER TABLE "optio"."stage_jev_gates" ALTER COLUMN "gate_kind" SET DATA TYPE "optio"."jev_gate_kind" USING "gate_kind"::"optio"."jev_gate_kind";--> statement-breakpoint
ALTER TABLE "optio"."workspaces" ALTER COLUMN "default_coding_backend" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "optio"."workspaces" ALTER COLUMN "default_coding_backend" SET DATA TYPE "optio"."coding_backend" USING "default_coding_backend"::"optio"."coding_backend";--> statement-breakpoint
ALTER TABLE "optio"."workspaces" ALTER COLUMN "default_coding_backend" SET DEFAULT 'cursor-cli'::"optio"."coding_backend";--> statement-breakpoint
ALTER TABLE "optio"."agent_connections" ADD CONSTRAINT "agent_connections_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "optio"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."agent_connections" ADD CONSTRAINT "agent_connections_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "optio"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."agent_skills" ADD CONSTRAINT "agent_skills_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "optio"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."agent_skills" ADD CONSTRAINT "agent_skills_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "optio"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."agents" ADD CONSTRAINT "agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "optio"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."connections" ADD CONSTRAINT "connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "optio"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."skill_pick_logs" ADD CONSTRAINT "skill_pick_logs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "optio"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."skill_pick_logs" ADD CONSTRAINT "skill_pick_logs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "optio"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."skills" ADD CONSTRAINT "skills_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "optio"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."stage_jev_gates" ADD CONSTRAINT "stage_jev_gates_workflow_stage_id_workflow_stages_id_fk" FOREIGN KEY ("workflow_stage_id") REFERENCES "optio"."workflow_stages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."transcript_events" ADD CONSTRAINT "transcript_events_transcript_id_transcripts_id_fk" FOREIGN KEY ("transcript_id") REFERENCES "optio"."transcripts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."transcripts" ADD CONSTRAINT "transcripts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "optio"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "optio"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."workflow_agents" ADD CONSTRAINT "workflow_agents_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "optio"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."workflow_agents" ADD CONSTRAINT "workflow_agents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "optio"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."workflow_stages" ADD CONSTRAINT "workflow_stages_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "optio"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."workflow_stages" ADD CONSTRAINT "workflow_stages_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "optio"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."workflows" ADD CONSTRAINT "workflows_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "optio"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."workspace_memberships" ADD CONSTRAINT "workspace_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "optio"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."workspace_memberships" ADD CONSTRAINT "workspace_memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "optio"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."workspaces" ADD CONSTRAINT "workspaces_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "optio"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flue"."sessions" DROP COLUMN "optio_transcript_id";
