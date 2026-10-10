-- Finance and tax dashboard, slice 2: the asset register.
--
-- An asset's cost, schedule and book values are never stored: the cost is the
-- sum of the receipts linked through tax_asset_parts, and the rest is computed
-- on read. These tables hold only what a person stated about the asset.
--
-- Additive only. Nothing existing is altered, so this is safe to apply to the
-- live database at boot (start.sh runs `prisma migrate deploy`).

CREATE TABLE "tax_assets" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "label" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "acquisition_date" TEXT,
    "method" TEXT NOT NULL,
    "useful_life_months" INTEGER,
    "declining_rate_bp" INTEGER,
    "business_share_bp" INTEGER NOT NULL DEFAULT 10000,
    "reminder_cents" INTEGER NOT NULL DEFAULT 0,
    "opening_year" INTEGER,
    "opening_book_value_cents" INTEGER,
    "opening_remaining_months" INTEGER,
    "disposal_date" TEXT,
    "disposal_kind" TEXT,
    "disposal_proceeds_cents" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_assets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tax_assets_auth_workspace_id_idx" ON "tax_assets"("auth_workspace_id");

-- A receipt that is part of an asset's cost. row_id is unique: a receipt
-- belongs to at most one asset. It has NO foreign key, for the same reason as
-- meal_guests.row_id (a receipt row lives in one of two storage layouts); the
-- row delete paths remove the link in application code. asset_id does have
-- one: deleting an asset frees its receipts.
CREATE TABLE "tax_asset_parts" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "asset_id" TEXT NOT NULL,
    "row_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_asset_parts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tax_asset_parts_row_id_key" ON "tax_asset_parts"("row_id");
CREATE INDEX "tax_asset_parts_asset_id_idx" ON "tax_asset_parts"("asset_id");

-- A receipt on the low-value asset line whose total is above the limit is
-- normally sent to the asset register. This records the owner's statement that
-- it holds several assets, each within the limit on its own.
ALTER TABLE "tax_item_decisions" ADD COLUMN "several_low_value_items" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "tax_asset_parts" ADD CONSTRAINT "tax_asset_parts_asset_id_fkey"
    FOREIGN KEY ("asset_id") REFERENCES "tax_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
