-- Attach preferences on the import config: which Drive folder holds the source
-- invoices and which sheet column names the file. Persisted by a successful
-- attach run; nullable because existing configs predate the feature.
ALTER TABLE "sheet_import_configs" ADD COLUMN "attach_folder_id" TEXT;
ALTER TABLE "sheet_import_configs" ADD COLUMN "attach_folder_name" TEXT;
ALTER TABLE "sheet_import_configs" ADD COLUMN "source_file_header" TEXT;
