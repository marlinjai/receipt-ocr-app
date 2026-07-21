-- CreateTable
CREATE TABLE "google_sheets_credentials" (
    "id" TEXT NOT NULL,
    "auth_user_id" TEXT NOT NULL,
    "google_email" TEXT,
    "refresh_token_encrypted" TEXT NOT NULL,
    "scopes" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "google_sheets_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sheet_import_configs" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "spreadsheet_id" TEXT NOT NULL,
    "sheet_name" TEXT NOT NULL,
    "header_row" INTEGER NOT NULL DEFAULT 1,
    "column_mapping" JSONB NOT NULL,
    "dedup_key_fields" JSONB NOT NULL,
    "created_by_user_id" TEXT NOT NULL,
    "last_run_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sheet_import_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sheet_import_rows" (
    "id" TEXT NOT NULL,
    "config_id" TEXT NOT NULL,
    "dedup_key" TEXT NOT NULL,
    "dt_row_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sheet_import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "google_sheets_credentials_auth_user_id_key" ON "google_sheets_credentials"("auth_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "sheet_import_configs_auth_workspace_id_spreadsheet_id_sheet_key" ON "sheet_import_configs"("auth_workspace_id", "spreadsheet_id", "sheet_name");

-- CreateIndex
CREATE UNIQUE INDEX "sheet_import_rows_config_id_dedup_key_key" ON "sheet_import_rows"("config_id", "dedup_key");

-- AddForeignKey
ALTER TABLE "sheet_import_rows" ADD CONSTRAINT "sheet_import_rows_config_id_fkey" FOREIGN KEY ("config_id") REFERENCES "sheet_import_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

