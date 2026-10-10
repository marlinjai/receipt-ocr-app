-- Finance and tax dashboard, slice 3: payments imported from export files,
-- how counterparties are treated, and links from payments to receipts and
-- issued invoices.
--
-- Additive only: five new tables. Nothing existing is altered, so this is safe
-- to apply to the live database at boot (start.sh runs `prisma migrate deploy`).
-- No full account number is stored in any of them.

CREATE TABLE "tax_accounts" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "label" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_accounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tax_accounts_auth_workspace_id_label_key" ON "tax_accounts"("auth_workspace_id", "label");

-- One imported file per row; the same file is refused twice for one account.
CREATE TABLE "tax_import_batches" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "account_id" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "payment_count" INTEGER NOT NULL,
    "new_count" INTEGER NOT NULL,
    "first_day" TEXT,
    "last_day" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_import_batches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tax_import_batches_account_id_content_hash_key" ON "tax_import_batches"("account_id", "content_hash");

ALTER TABLE "tax_import_batches" ADD CONSTRAINT "tax_import_batches_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "tax_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One booked movement. source_hash is its identity within the account, so an
-- overlapping export adds nothing twice.
CREATE TABLE "tax_payments" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "account_id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "booking_day" TEXT NOT NULL,
    "value_day" TEXT,
    "amount_cents" INTEGER NOT NULL,
    "counterparty" TEXT NOT NULL,
    "counterparty_key" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "entry_reference" TEXT,
    "source_kind" TEXT NOT NULL,
    "kind_override" TEXT,
    "source_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_payments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tax_payments_account_id_source_hash_key" ON "tax_payments"("account_id", "source_hash");
CREATE INDEX "tax_payments_auth_workspace_id_booking_day_idx" ON "tax_payments"("auth_workspace_id", "booking_day");

ALTER TABLE "tax_payments" ADD CONSTRAINT "tax_payments_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "tax_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tax_payments" ADD CONSTRAINT "tax_payments_batch_id_fkey"
    FOREIGN KEY ("batch_id") REFERENCES "tax_import_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "tax_counterparty_rules" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "counterparty_key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "treatment" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_counterparty_rules_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tax_counterparty_rules_auth_workspace_id_counterparty_key_key"
    ON "tax_counterparty_rules"("auth_workspace_id", "counterparty_key");

-- A payment, or part of it, that belongs to a receipt row or an issued
-- invoice. row_id has NO foreign key, for the same reason as
-- meal_guests.row_id; the row delete paths remove the link in code.
CREATE TABLE "tax_payment_links" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "payment_id" TEXT NOT NULL,
    "row_id" TEXT,
    "invoice_id" TEXT,
    "cents" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_payment_links_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tax_payment_links_payment_id_idx" ON "tax_payment_links"("payment_id");
CREATE INDEX "tax_payment_links_row_id_idx" ON "tax_payment_links"("row_id");
CREATE INDEX "tax_payment_links_invoice_id_idx" ON "tax_payment_links"("invoice_id");

ALTER TABLE "tax_payment_links" ADD CONSTRAINT "tax_payment_links_payment_id_fkey"
    FOREIGN KEY ("payment_id") REFERENCES "tax_payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tax_payment_links" ADD CONSTRAINT "tax_payment_links_invoice_id_fkey"
    FOREIGN KEY ("invoice_id") REFERENCES "tax_issued_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
