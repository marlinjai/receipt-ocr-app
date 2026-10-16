-- The missing-receipt loop and its notifications (plan 2026-10-14, steps 1,
-- 2 and 5). Additive: three new tables, nothing existing is touched.
CREATE TABLE "spending_receipt_answers" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "payment_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spending_receipt_answers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "spending_settings" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'push',
    "notify_email" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "spending_settings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "spending_notifications" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "subject_key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "channel" TEXT,
    "attempts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "failed" BOOLEAN NOT NULL DEFAULT false,
    "tries" INTEGER NOT NULL DEFAULT 0,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "spending_notifications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "spending_receipt_answers_auth_workspace_id_payment_id_key" ON "spending_receipt_answers"("auth_workspace_id", "payment_id");

CREATE UNIQUE INDEX "spending_settings_auth_workspace_id_key" ON "spending_settings"("auth_workspace_id");

CREATE INDEX "spending_notifications_auth_workspace_id_read_at_idx" ON "spending_notifications"("auth_workspace_id", "read_at");

CREATE UNIQUE INDEX "spending_notifications_auth_workspace_id_subject_key_key" ON "spending_notifications"("auth_workspace_id", "subject_key");
