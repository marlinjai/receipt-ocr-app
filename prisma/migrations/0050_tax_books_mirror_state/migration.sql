-- The last pull of the issued documents from framer-clone's Books, per workspace
-- (src/lib/tax/books-pull): when, how, whether it landed, and its report, so the
-- "Einnahmen" tab shows a failed or conflicted pull. Additive: one new table.
-- Numbered 0050 because a parallel change holds 0049; the two are independent.
CREATE TABLE "tax_books_mirror_state" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "last_trigger" TEXT NOT NULL,
    "last_run_at" TIMESTAMP(3) NOT NULL,
    "last_ok" BOOLEAN NOT NULL,
    "last_error" TEXT,
    "last_report" JSONB,
    "last_success_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_books_mirror_state_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tax_books_mirror_state_auth_workspace_id_key" ON "tax_books_mirror_state"("auth_workspace_id");
