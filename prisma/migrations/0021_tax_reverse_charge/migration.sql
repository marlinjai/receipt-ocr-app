-- The owner's statement that the buyer owes the tax on a purchase (section 13b
-- of the value-added tax act), per receipt or per vendor from a day on.
-- Additive: one new table, no existing row is read or rewritten, so every
-- figure computed before stays as it was until a statement is recorded.
CREATE TABLE "tax_reverse_charges" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "scope" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "effective_from" TEXT NOT NULL DEFAULT '',
    "rate_bp" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_reverse_charges_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tax_reverse_charges_scope_check" CHECK ("scope" IN ('row', 'vendor')),
    CONSTRAINT "tax_reverse_charges_rate_check" CHECK ("rate_bp" IS NULL OR "rate_bp" IN (1900, 700))
);

CREATE UNIQUE INDEX "tax_reverse_charges_subject_key" ON "tax_reverse_charges"("auth_workspace_id", "scope", "subject", "effective_from");
