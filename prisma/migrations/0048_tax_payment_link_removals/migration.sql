-- A filed year holds its receipts against payment links made after its filing day (filedHoldOf in
-- src/lib/tax/year-boundary.ts). To know which payments a receipt had on a filing day, a link that is
-- taken off a receipt leaves a record of what it was: the payment's day and direction, and when the
-- link was made and removed. Additive: one new table, nothing existing changes.
CREATE TABLE "tax_payment_link_removals" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "row_id" TEXT NOT NULL,
    "booking_day" TEXT NOT NULL,
    "money_out" BOOLEAN NOT NULL,
    "cents" INTEGER NOT NULL,
    "linked_at" TIMESTAMP(3) NOT NULL,
    "removed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_payment_link_removals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tax_payment_link_removals_auth_workspace_id_row_id_idx" ON "tax_payment_link_removals"("auth_workspace_id", "row_id");
