-- Review state per receipt: the doubts the reader recorded, what a person has
-- confirmed, and which look-alike receipts a person has said are different
-- purchases. Until now a look-alike warning and a "could not be read" hint
-- lived only on the upload page and were gone when it was left.
--
-- Additive only. Nothing existing is altered, so this is safe to apply to the
-- live database at boot (start.sh runs `prisma migrate deploy`).
--
-- row_id has NO foreign key: a receipt row lives either in dt_rows or in a
-- per-table physical table, so there is no single table to reference. The row
-- delete paths remove the review in application code.
CREATE TABLE "receipt_reviews" (
    "row_id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "distinct_from" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "checked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "receipt_reviews_pkey" PRIMARY KEY ("row_id")
);

CREATE INDEX "receipt_reviews_auth_workspace_id_idx" ON "receipt_reviews"("auth_workspace_id");
