-- "Was ist das?" (plan docs/plans/2026-11-07-learned-assignment.md, decision 8): a person's short answer
-- about one vendor or counterparty is a freetext statement with the subject it is about; and the app says
-- what it takes a counterparty to be. Additive: two nullable columns and an index, nothing changes value.
ALTER TABLE "classification_rules" ADD COLUMN "subject" TEXT;
CREATE INDEX "classification_rules_auth_workspace_id_subject_idx" ON "classification_rules"("auth_workspace_id", "subject");
ALTER TABLE "tax_counterparty_verdicts" ADD COLUMN "what" TEXT;
