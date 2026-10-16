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
