-- Private spending (plan 2026-10-14): the spending category a person gave a
-- counterparty. Additive: one new table, nothing existing is touched.
CREATE TABLE "spending_category_answers" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "counterparty_key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "spending_category_answers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "spending_category_answers_auth_workspace_id_counterparty_ke_key" ON "spending_category_answers"("auth_workspace_id", "counterparty_key");
