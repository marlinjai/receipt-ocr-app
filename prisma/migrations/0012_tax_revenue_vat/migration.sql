-- Finance and tax dashboard, slices 4 and 5: revenue from issued invoices and
-- regular value-added taxation.
--
-- Additive only: three nullable columns and four new tables. Nothing existing
-- is altered or read differently until a person records something, so this is
-- safe to apply to the live database at boot (start.sh runs
-- `prisma migrate deploy`).

-- Asked once before any advance return period is computed, and the owner's own
-- expectation for the limit forecast. All NULL until answered.
ALTER TABLE "workspace_tax_settings" ADD COLUMN "vat_frequency" TEXT;
ALTER TABLE "workspace_tax_settings" ADD COLUMN "vat_method" TEXT;
ALTER TABLE "workspace_tax_settings" ADD COLUMN "expected_monthly_revenue_cents" INTEGER;

-- A change of the section 19 status from a day on. The first answer stays in
-- workspace_tax_settings.small_business.
CREATE TABLE "tax_status_changes" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "effective_from" TEXT NOT NULL,
    "small_business" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_status_changes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tax_status_changes_auth_workspace_id_effective_from_key"
    ON "tax_status_changes"("auth_workspace_id", "effective_from");

-- Issued invoices as a list (no document tier). No client name is stored.
CREATE TABLE "tax_issued_invoices" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "number" TEXT NOT NULL,
    "issue_date" TEXT,
    "gross_cents" INTEGER NOT NULL,
    "vat_cents" INTEGER NOT NULL DEFAULT 0,
    "treatment" TEXT NOT NULL,
    "declared_in_year" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_issued_invoices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tax_issued_invoices_auth_workspace_id_number_key"
    ON "tax_issued_invoices"("auth_workspace_id", "number");

CREATE TABLE "tax_invoice_payments" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "invoice_id" TEXT NOT NULL,
    "paid_on" TEXT NOT NULL,
    "cents" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_invoice_payments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tax_invoice_payments_invoice_id_idx" ON "tax_invoice_payments"("invoice_id");

ALTER TABLE "tax_invoice_payments" ADD CONSTRAINT "tax_invoice_payments_invoice_id_fkey"
    FOREIGN KEY ("invoice_id") REFERENCES "tax_issued_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Value-added tax paid to the tax office, or refunded by it.
CREATE TABLE "tax_vat_settlements" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "settled_on" TEXT NOT NULL,
    "cents" INTEGER NOT NULL,
    "direction" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_vat_settlements_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tax_vat_settlements_auth_workspace_id_idx" ON "tax_vat_settlements"("auth_workspace_id");
