-- Finance and tax dashboard, slice 1: the two tables that hold what a person
-- decided about the tax treatment of receipts. Figures are never stored; they
-- are computed on read from the receipt rows, these decisions and the rule set
-- of the year.
--
-- Additive only. Nothing existing is altered, so this is safe to apply to the
-- live database at boot (start.sh runs `prisma migrate deploy`).

-- Default treatment per vendor, as dated entries. effective_from is an ISO day
-- or '' for "from the beginning": NOT NULL on purpose, because with a nullable
-- column the unique index would accept two "from the beginning" entries for
-- one vendor (Postgres treats NULLs as distinct).
CREATE TABLE "tax_vendor_rules" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "vendor_key" TEXT NOT NULL,
    "vendor_label" TEXT NOT NULL,
    "effective_from" TEXT NOT NULL DEFAULT '',
    "allocations" JSONB NOT NULL,
    "form_line_key" TEXT,
    "employment_line_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_vendor_rules_pkey" PRIMARY KEY ("id")
);

-- The name is the one Prisma derives: Postgres limits identifiers to 63
-- characters, so "effective_from" is cut to "effective_fro".
CREATE UNIQUE INDEX "tax_vendor_rules_auth_workspace_id_vendor_key_effective_fro_key"
    ON "tax_vendor_rules"("auth_workspace_id", "vendor_key", "effective_from");

-- A decision for one receipt row. row_id has NO foreign key: a receipt row
-- lives either in dt_rows or in a per-table physical table, so there is no
-- single table to reference. The row delete paths remove the decision in
-- application code.
CREATE TABLE "tax_item_decisions" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "row_id" TEXT NOT NULL,
    "allocations" JSONB NOT NULL,
    "form_line_key" TEXT,
    "employment_line_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_item_decisions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tax_item_decisions_row_id_key" ON "tax_item_decisions"("row_id");
CREATE INDEX "tax_item_decisions_auth_workspace_id_idx" ON "tax_item_decisions"("auth_workspace_id");
