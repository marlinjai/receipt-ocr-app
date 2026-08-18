-- Tenant scoping: every receipts row becomes attributable to exactly one
-- auth-brain tenant (company), not merely to a workspace.
--
-- Why this is needed even though rows already carry a workspace id: a workspace
-- belongs to exactly one company, but the workspace id alone does not say which,
-- so nothing in this database can answer "which company owns this row" without
-- calling auth-brain. Phase 0 of the books/receipts integration needs that
-- answer locally, per row.
--
-- NULLABLE on purpose, in two senses:
--   1. Existing rows predate the column and are backfilled separately
--      (scripts/backfill-tenant-ids.ts), so a NOT NULL column would make this
--      migration unrunnable against the live database.
--   2. It stays nullable AFTER the backfill because the development bypass
--      session has no company at all. The write path, not the column, is what
--      refuses to persist a NULL tenant for a real session: see
--      requireSessionTenantId() in src/lib/auth-workspace.ts, which throws
--      rather than silently writing NULL. That ordering is deliberate. A NOT
--      NULL constraint here would turn a caught application error into a
--      500 from the database.
ALTER TABLE "dt_tables" ADD COLUMN "auth_tenant_id" TEXT;
ALTER TABLE "sheet_import_configs" ADD COLUMN "auth_tenant_id" TEXT;
ALTER TABLE "workspace_vendor_attribution" ADD COLUMN "auth_tenant_id" TEXT;
ALTER TABLE "overview_selections" ADD COLUMN "auth_tenant_id" TEXT;
ALTER TABLE "workspace_notes" ADD COLUMN "auth_tenant_id" TEXT;

-- Read pattern this anticipates: "everything owned by company X", which is the
-- whole point of the column. Partial indexes because the backfill leaves no
-- NULLs behind for real rows and the dev bypass should not occupy index space.
CREATE INDEX "dt_tables_auth_tenant_id_idx" ON "dt_tables" ("auth_tenant_id") WHERE "auth_tenant_id" IS NOT NULL;
CREATE INDEX "sheet_import_configs_auth_tenant_id_idx" ON "sheet_import_configs" ("auth_tenant_id") WHERE "auth_tenant_id" IS NOT NULL;
CREATE INDEX "workspace_vendor_attribution_auth_tenant_id_idx" ON "workspace_vendor_attribution" ("auth_tenant_id") WHERE "auth_tenant_id" IS NOT NULL;
CREATE INDEX "overview_selections_auth_tenant_id_idx" ON "overview_selections" ("auth_tenant_id") WHERE "auth_tenant_id" IS NOT NULL;
CREATE INDEX "workspace_notes_auth_tenant_id_idx" ON "workspace_notes" ("auth_tenant_id") WHERE "auth_tenant_id" IS NOT NULL;
