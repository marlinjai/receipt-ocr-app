-- Own names (plan docs/plans/2026-10-23-budget-overview.md, decision 1). Additive: one column with an
-- empty default, nothing existing changes. A counterparty carrying one of these names counts as an own
-- account on read; nothing is written to the payments.
ALTER TABLE "spending_settings" ADD COLUMN "own_names" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
