-- Every line of every receipt (plan docs/plans/2026-10-26-receipt-line-items.md).
-- Additive: three new tables. receipt_items holds a receipt's printed positions for
-- reading and the spending overview, never for tax (tax_receipt_lines is untouched);
-- receipt_item_readings records that a receipt's lines were read (also when none were
-- found), receipt_item_kind_answers a person's kind for a text at one shop.
CREATE TABLE "receipt_items" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "row_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION,
    "unit_price_cents" INTEGER,
    "gross_cents" INTEGER NOT NULL,
    "net_cents" INTEGER,
    "tax_rate" DOUBLE PRECISION,
    "kind" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "receipt_items_auth_workspace_id_row_id_idx" ON "receipt_items"("auth_workspace_id", "row_id");

CREATE TABLE "receipt_item_readings" (
    "row_id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "outcome" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "line_count" INTEGER NOT NULL DEFAULT 0,
    "lines_sum_cents" INTEGER,
    "lines_net_cents" INTEGER,
    "total_net_cents" INTEGER,
    "text_cut" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "transient_failures" INTEGER NOT NULL DEFAULT 0,
    "model" TEXT,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "read_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "receipt_item_readings_pkey" PRIMARY KEY ("row_id")
);

CREATE INDEX "receipt_item_readings_auth_workspace_id_outcome_idx" ON "receipt_item_readings"("auth_workspace_id", "outcome");

CREATE TABLE "receipt_item_kind_answers" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "vendor_key" TEXT NOT NULL,
    "text_key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "receipt_item_kind_answers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "receipt_item_kind_answers_auth_workspace_id_vendor_key_text_key_key" ON "receipt_item_kind_answers"("auth_workspace_id", "vendor_key", "text_key");
