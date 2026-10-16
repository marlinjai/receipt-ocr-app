-- The finance decision becomes the one source of who bears a receipt; the two
-- older cells ("Zuordnung", "Business Share %") show it. Additive: one nullable
-- column and one new table, no row is rewritten and nothing is dropped.

-- A decision can carry a note of why (until now such a note stood in the receipt's name).
ALTER TABLE "tax_item_decisions" ADD COLUMN "note" TEXT;

-- What the two cells held before a decision or a vendor rule first decided the
-- receipt (so removing the decision restores them exactly), or the share a
-- private receipt held before it was set to 0 (so nothing typed is lost).
CREATE TABLE "tax_assignment_origins" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "row_id" TEXT NOT NULL,
    "zuordnung" TEXT,
    "share_percent" DOUBLE PRECISION,
    "reason" TEXT NOT NULL DEFAULT 'decided',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_assignment_origins_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tax_assignment_origins_row_id_key" ON "tax_assignment_origins"("row_id");
CREATE INDEX "tax_assignment_origins_auth_workspace_id_idx" ON "tax_assignment_origins"("auth_workspace_id");
