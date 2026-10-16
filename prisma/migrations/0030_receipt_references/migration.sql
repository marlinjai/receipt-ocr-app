-- Which invoice a receipt refers to: a credit note and the invoice it corrects.
-- Additive: one new table, nothing existing is touched. `row_id` and
-- `referenced_row_id` have no foreign key for the same reason as
-- meal_guests.row_id; the row delete paths remove the reference in code.
CREATE TABLE "receipt_references" (
    "row_id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "kind" TEXT NOT NULL,
    "referenced_invoice_number" TEXT,
    "referenced_row_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "receipt_references_pkey" PRIMARY KEY ("row_id")
);

CREATE INDEX "receipt_references_auth_workspace_id_idx" ON "receipt_references"("auth_workspace_id");
CREATE INDEX "receipt_references_referenced_row_id_idx" ON "receipt_references"("referenced_row_id");

-- Credit notes read before this table existed carry the review flag "credit_note"
-- and no amount: they are recorded as credit notes naming no invoice, so they are
-- never taken for an invoice and the review list keeps asking for them.
INSERT INTO "receipt_references" ("row_id", "auth_workspace_id", "auth_tenant_id", "kind", "referenced_invoice_number", "referenced_row_id", "created_at", "updated_at")
SELECT "row_id", "auth_workspace_id", "auth_tenant_id", 'credit_note', NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "receipt_reviews"
WHERE 'credit_note' = ANY("flags")
ON CONFLICT ("row_id") DO NOTHING;
