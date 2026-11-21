-- The record of every company erasure this app received and what each run of it
-- did (plan docs/plans/2026-11-21-company-erasure-register.md). One new table,
-- nothing existing changes. Ids, counts and reason codes only. The company is
-- named in "company_id", not in the stamp "auth_tenant_id": the stamp marks rows
-- an erasure removes, and this row is the one an erasure leaves behind.
-- "lease_token" and "lease_until" mark the run that is at work on an event: one
-- erasure at a time in the whole app, and a lease that is not renewed runs out.
CREATE TABLE "erasure_events" (
    "event_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "workspace_ids" TEXT[],
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "runs" JSONB NOT NULL DEFAULT '[]',
    "lease_token" TEXT,
    "lease_until" TIMESTAMP(3),
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "erasure_events_pkey" PRIMARY KEY ("event_id")
);

CREATE INDEX "erasure_events_company_id_idx" ON "erasure_events"("company_id");
