-- The app classifies payments by itself (plan docs/plans/2026-10-25-auto-classify-payments.md).
-- Additive: one new table. A row is what the APP decided about a counterparty (private,
-- business, own account or mixed, and a spending category), with how sure it is and why;
-- a person's answer stays in tax_counterparty_rules and spending_category_answers and wins.
CREATE TABLE "tax_counterparty_verdicts" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "counterparty_key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "treatment" TEXT,
    "category" TEXT,
    "confidence" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "model" TEXT,
    "fingerprint" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_counterparty_verdicts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tax_counterparty_verdicts_auth_workspace_id_counterparty_key_key" ON "tax_counterparty_verdicts"("auth_workspace_id", "counterparty_key");
