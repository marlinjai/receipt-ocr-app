---
title: Retention purge activation preparation
summary: Signed purge preparation pending recorded legal retention policy confirmation.
type: documentation
tags: [operations, retention, privacy]
projects: [receipt-ocr-app]
date: 2026-10-09
---

# Retention purge activation preparation

The daily purge is not enabled. `src/lib/erasure.ts` explicitly requires a lawyer's
confirmation of the ten-year retention period before go-live. The original contacts
implementation owner confirmed that no such approval is recorded. Engineering
approval cannot replace this legal decision.

Production database backups, independent copies and scratch restoration are
verified. `RETENTION_PURGE_SECRET` was generated server-side in Infisical project
`95d42533-3157-4b66-a49b-cc386ec1214d`, production environment, path `/`, on
2026-10-09. The value never entered a transcript or this repository.

The purge deletes only a detached guest copy with a `retain_until` timestamp
strictly in the past. Copies without a retention date or still linked to a contact
are preserved. Existing tests cover missing secrets, invalid signatures, signed
success, visible failure, and preservation of linked and unexpired copies.

The app fetches secrets on startup. Restarting loads the prepared secret but does
not create a schedule.

## Activation after legal confirmation

1. Record the approved record classes, retention rule, starting date and hold
   exceptions in the owning plan. Adjust implementation and tests if necessary.
2. Check aggregate eligible-row counts and verify a fresh recovery point.
3. Verify missing and invalid signatures fail without deleting data.
4. Through the secrets proxy with receipts production secrets injected, compute
   a Hash-based Message Authentication Code (HMAC) using Secure Hash Algorithm
   256 (SHA-256) over an empty body. POST that body to
   `https://receipts.lumitra.co/api/internal/retention/purge`, using the header
   declared in `src/lib/erasure-signature.ts`. Never print the secret or signature.
5. Verify the response and removed-row count, including repeat execution.
6. Create the daily Coolify task with server-side Infisical injection, a bounded
   request timeout, and failure on a non-success response. Confirm its next run
   and execution history.

The exact external dependency is recorded legal confirmation of the policy.
