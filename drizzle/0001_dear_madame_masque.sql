CREATE TABLE "optio"."agent_connections" (
	"agent_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	CONSTRAINT "agent_connections_pkey" PRIMARY KEY("agent_id","connection_id")
);
--> statement-breakpoint
CREATE TABLE "optio"."connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"infisical_secret_path" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connections_workspace_id_kind_name_unique" UNIQUE("workspace_id","kind","name")
);
--> statement-breakpoint
CREATE TABLE "optio"."skill_pick_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"task_id" text,
	"task_type" text,
	"agent_id" uuid,
	"selected_skill_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "optio"."stage_jev_gates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_stage_id" uuid NOT NULL,
	"gate_kind" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"timeout_ms" integer DEFAULT 30000 NOT NULL,
	"passthrough_on_timeout" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stage_jev_gates_workflow_stage_id_gate_kind_unique" UNIQUE("workflow_stage_id","gate_kind")
);
--> statement-breakpoint
CREATE TABLE "optio"."transcript_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transcript_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"content" jsonb NOT NULL,
	"compacted" boolean DEFAULT false NOT NULL,
	"compacted_tokens" integer,
	"cache_writes" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transcript_events_transcript_id_seq_unique" UNIQUE("transcript_id","seq")
);
--> statement-breakpoint
CREATE TABLE "optio"."transcripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"flue_session_id" uuid,
	"task_id" text,
	"stage" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "optio"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_tenant_id_email_unique" UNIQUE("tenant_id","email")
);
--> statement-breakpoint
CREATE TABLE "optio"."workflow_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"agent_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_stages_workflow_id_slug_unique" UNIQUE("workflow_id","slug")
);
--> statement-breakpoint
CREATE TABLE "optio"."workspace_memberships" (
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_memberships_pkey" PRIMARY KEY("user_id","workspace_id")
);
--> statement-breakpoint
ALTER TABLE "optio"."agents" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "optio"."agents" ADD COLUMN "sandbox_mode" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "optio"."agents" ADD COLUMN "tools" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "optio"."agents" ADD COLUMN "subagents" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "optio"."workspaces" ADD COLUMN "default_coding_backend" text DEFAULT 'cursor-cli' NOT NULL;--> statement-breakpoint
ALTER TABLE "flue"."sessions" ADD COLUMN "optio_transcript_id" uuid;--> statement-breakpoint
ALTER TABLE "flue"."sessions" ADD COLUMN "durable_conversation_id" text;--> statement-breakpoint
ALTER TABLE "optio"."agent_connections" ADD CONSTRAINT "agent_connections_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "optio"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."agent_connections" ADD CONSTRAINT "agent_connections_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "optio"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."connections" ADD CONSTRAINT "connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "optio"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."skill_pick_logs" ADD CONSTRAINT "skill_pick_logs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "optio"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."stage_jev_gates" ADD CONSTRAINT "stage_jev_gates_workflow_stage_id_workflow_stages_id_fk" FOREIGN KEY ("workflow_stage_id") REFERENCES "optio"."workflow_stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."transcript_events" ADD CONSTRAINT "transcript_events_transcript_id_transcripts_id_fk" FOREIGN KEY ("transcript_id") REFERENCES "optio"."transcripts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."transcripts" ADD CONSTRAINT "transcripts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "optio"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "optio"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."workflow_stages" ADD CONSTRAINT "workflow_stages_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "optio"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."workflow_stages" ADD CONSTRAINT "workflow_stages_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "optio"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."workspace_memberships" ADD CONSTRAINT "workspace_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "optio"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optio"."workspace_memberships" ADD CONSTRAINT "workspace_memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "optio"."workspaces"("id") ON DELETE no action ON UPDATE no action;