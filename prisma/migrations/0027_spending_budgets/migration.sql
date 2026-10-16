-- Monthly budgets the owner set himself (plan 2026-10-14, build order 4).
-- Additive: one new table, nothing existing is touched.
CREATE TABLE "spending_budgets" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "limit_cents" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "spending_budgets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "spending_budgets_auth_workspace_id_scope_key_key" ON "spending_budgets"("auth_workspace_id", "scope", "key");
