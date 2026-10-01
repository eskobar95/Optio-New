INSERT INTO "optio"."tenants" ("id", "name", "slug")
SELECT '00000000-0000-4000-8000-000000000001', 'Legacy',
  CASE WHEN EXISTS (SELECT 1 FROM "optio"."tenants" WHERE "slug" = 'legacy')
    THEN 'legacy-00000000' ELSE 'legacy' END
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
INSERT INTO "optio"."workspaces" ("id", "tenant_id", "name", "slug")
SELECT '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'Legacy',
  CASE WHEN EXISTS (
    SELECT 1 FROM "optio"."workspaces"
    WHERE "tenant_id" = '00000000-0000-4000-8000-000000000001' AND "slug" = 'legacy')
    THEN 'legacy-00000000' ELSE 'legacy' END
ON CONFLICT ("id") DO NOTHING;
