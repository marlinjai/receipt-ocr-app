-- An asset used partly for study or employment: that share of its depreciation
-- goes on the employment annex (Anlage N), on the line named here. Additive: two
-- columns with defaults that keep every existing asset exactly as it was (no
-- annex share, no line).
ALTER TABLE "tax_assets" ADD COLUMN "annex_share_bp" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "tax_assets" ADD COLUMN "annex_line_key" TEXT;
