-- Step 3 of the missing-receipt loop (plan 2026-10-14): the mailbox searches
-- and the mail attachments found. Additive: two new tables, nothing existing is touched.
CREATE TABLE "spending_mail_searches" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "payment_id" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "tries" INTEGER NOT NULL DEFAULT 0,
    "searched_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spending_mail_searches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "spending_mail_candidates" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "payment_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "part_index" INTEGER NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "received_day" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "dismissed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spending_mail_candidates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "spending_mail_searches_auth_workspace_id_payment_id_key" ON "spending_mail_searches"("auth_workspace_id", "payment_id");

CREATE INDEX "spending_mail_candidates_auth_workspace_id_payment_id_idx" ON "spending_mail_candidates"("auth_workspace_id", "payment_id");

CREATE UNIQUE INDEX "spending_mail_candidates_auth_workspace_id_payment_id_messa_key" ON "spending_mail_candidates"("auth_workspace_id", "payment_id", "message_id", "part_index");

