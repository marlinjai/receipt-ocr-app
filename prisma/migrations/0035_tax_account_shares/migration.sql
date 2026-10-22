-- Payments across companies (plan docs/plans/2026-10-22-payments-across-companies.md).
-- Additive: one new table, nothing existing is touched. A row says that the
-- private payments of one account go to another company of the same person;
-- which payment goes where is worked out on read, nothing is copied.
CREATE TABLE "tax_account_shares" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "account_id" TEXT NOT NULL,
    "receiver_workspace_id" TEXT NOT NULL,
    "receiver_tenant_id" TEXT,
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_account_shares_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tax_account_shares_account_id_key" ON "tax_account_shares"("account_id");
CREATE INDEX "tax_account_shares_auth_workspace_id_idx" ON "tax_account_shares"("auth_workspace_id");
CREATE INDEX "tax_account_shares_receiver_workspace_id_idx" ON "tax_account_shares"("receiver_workspace_id");

ALTER TABLE "tax_account_shares" ADD CONSTRAINT "tax_account_shares_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "tax_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
