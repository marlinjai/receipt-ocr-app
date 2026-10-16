-- Push to the installed phone app (plan 2026-10-14, owner's answer of 2026-10-15):
-- the push subscriptions. Additive: one new table, nothing existing is touched.
CREATE TABLE "spending_push_subscriptions" (
    "id" TEXT NOT NULL,
    "auth_workspace_id" TEXT NOT NULL,
    "auth_tenant_id" TEXT,
    "user_id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "last_success_at" TIMESTAMP(3),
    "renewed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "spending_push_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "spending_push_subscriptions_endpoint_idx" ON "spending_push_subscriptions"("endpoint");

CREATE UNIQUE INDEX "spending_push_subscriptions_auth_workspace_id_endpoint_key" ON "spending_push_subscriptions"("auth_workspace_id", "endpoint");

