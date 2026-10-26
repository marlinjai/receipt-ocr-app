-- The table storage's lookups by owner had no index: every page load scanned dt_files, dt_columns,
-- select_options, dt_tables and dt_views in full (tens of thousands of scans by 2026-10-26). Harmless at
-- today's size (about 1,200 files, 140 columns), but each grows with the receipts. Plan
-- docs/plans/2026-10-26-fast-dashboard-and-spending.md.
CREATE INDEX IF NOT EXISTS "dt_tables_workspace_id_idx" ON "dt_tables"("workspace_id");
CREATE INDEX IF NOT EXISTS "dt_columns_table_id_idx" ON "dt_columns"("table_id");
CREATE INDEX IF NOT EXISTS "select_options_column_id_idx" ON "select_options"("column_id");
CREATE INDEX IF NOT EXISTS "dt_files_row_id_idx" ON "dt_files"("row_id");
CREATE INDEX IF NOT EXISTS "dt_views_table_id_idx" ON "dt_views"("table_id");
