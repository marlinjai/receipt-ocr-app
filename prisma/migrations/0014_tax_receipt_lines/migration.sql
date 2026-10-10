-- Finance and tax dashboard, second half of slice 2: receipt lines.
--
-- One new table, one new column with a default, and one index exchanged for a
-- wider one. No row is changed or removed.
--
-- The exchange: an asset part used to be unique per receipt. A part can now be
-- one line of a receipt, so uniqueness becomes (receipt, line), where line_id
-- '' means the whole receipt. Every existing part gets '' and stays unique
-- exactly as before, so the new index cannot fail on existing data.

CREATE TABLE "tax_receipt_lines" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "row_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL,
    "gross_cents" INTEGER NOT NULL,
    "net_cents" INTEGER,
    "allocations" JSONB,
    "form_line_key" TEXT,
    "employment_line_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_receipt_lines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tax_receipt_lines_auth_workspace_id_row_id_idx" ON "tax_receipt_lines"("auth_workspace_id", "row_id");

ALTER TABLE "tax_asset_parts" ADD COLUMN "line_id" TEXT NOT NULL DEFAULT '';

-- The new index first, so there is no moment without a uniqueness guarantee.
CREATE UNIQUE INDEX "tax_asset_parts_row_id_line_id_key" ON "tax_asset_parts"("row_id", "line_id");
DROP INDEX "tax_asset_parts_row_id_key";
