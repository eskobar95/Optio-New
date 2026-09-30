INSERT INTO "optio"."tenants" ("id", "name", "slug")
VALUES ('00000000-0000-4000-8000-000000000001', 'Legacy', 'legacy')
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "optio"."workspaces" ("id", "tenant_id", "name", "slug")
VALUES ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'Legacy', 'legacy')
ON CONFLICT DO NOTHING;
