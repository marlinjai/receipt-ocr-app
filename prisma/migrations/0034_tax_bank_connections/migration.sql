-- The live bank connection of an account (finance plan, slice 3, Enable Banking).
-- Additive: two new tables, nothing existing is touched. Movements still go into
-- tax_payments through the normal import; this table holds only the connection.
CREATE TABLE "tax_bank_connections" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "account_id" TEXT NOT NULL,
    "aspsp_name" TEXT NOT NULL,
    "aspsp_country" TEXT NOT NULL,
    "pending_aspsp_name" TEXT,
    "pending_aspsp_country" TEXT,
    "status" TEXT NOT NULL,
    "state_hash" TEXT,
    "state_expires_at" TIMESTAMP(3),
    "session_id" TEXT,
    "account_uid" TEXT,
    "candidates" JSONB,
    "bound_mask" TEXT,
    "bound_name" TEXT,
    "valid_until" TIMESTAMP(3),
    "last_synced_at" TIMESTAMP(3),
    "last_booked_through" TEXT,
    "last_error" TEXT,
    "last_error_at" TIMESTAMP(3),
    "notices" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_bank_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tax_bank_connections_account_id_key" ON "tax_bank_connections"("account_id");

CREATE INDEX "tax_bank_connections_auth_workspace_id_idx" ON "tax_bank_connections"("auth_workspace_id");

CREATE INDEX "tax_bank_connections_state_hash_idx" ON "tax_bank_connections"("state_hash");

CREATE INDEX "tax_bank_connections_status_idx" ON "tax_bank_connections"("status");

ALTER TABLE "tax_bank_connections" ADD CONSTRAINT "tax_bank_connections_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "tax_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The last accepted call of the daily fetch, so a signed call runs once even
-- after a restart or with several app instances.
CREATE TABLE "tax_bank_sync_guard" (
    "id" TEXT NOT NULL,
    "last_ts" INTEGER NOT NULL,

    CONSTRAINT "tax_bank_sync_guard_pkey" PRIMARY KEY ("id")
);
