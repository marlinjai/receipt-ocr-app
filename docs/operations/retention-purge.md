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

## Research: which retention period applies (2026-10-15)

Read from the statutes on 2026-10-15, as preparation for the legal confirmation, not
in place of it. Result: **the guest list of a business meal is kept 8 years since
2025, counted from the end of the year of the meal, not 10 years from the day a
contact is erased.** The code still holds 10 years from erasure, which is longer than
required. It is left unchanged here because the purge is not enabled and the period
still needs the recorded confirmation above; the change below is ready to make once
that confirmation names the rule.

- **Section 147 paragraph 3 sentence 1 of the fiscal code (Abgabenordnung, AO), as
  amended by the fourth bureaucracy relief act (Viertes Bürokratieentlastungsgesetz,
  Federal Law Gazette 2024 I number 323):** books and records (paragraph 1 number 1)
  are kept ten years, booking vouchers (Buchungsbelege, paragraph 1 number 4) eight
  years, other business letters six years.
  https://www.gesetze-im-internet.de/ao_1977/__147.html
- **Transition (Article 97 section 19a paragraph 2 of the introductory act to the
  fiscal code):** the eight years apply to every voucher whose ten-year period had not
  run out by 31 December 2024. Banks, insurers and investment firms keep ten years
  (paragraph 3); not relevant here.
  https://www.gesetze-im-internet.de/aoeg_1977/art_97__19a.html
- **What a meal record is.** Section 4 paragraph 5 sentence 1 number 2 sentence 3 of
  the income tax act says the restaurant's invoice is attached to the written record
  of occasion and guests, and the ministry's letter of 19 November 2025 (margin
  number 20) asks for the record to be joined digitally with the invoice. Record,
  guest list and invoice therefore form one booking voucher: **8 years**. A received
  invoice is also kept 8 years under section 14b paragraph 1 of the value-added tax
  act. https://www.gesetze-im-internet.de/ustg_1980/__14b.html
- **What stays 10 years.** Section 4 paragraph 7 of the income tax act requires meal
  expenses to be recorded "einzeln und getrennt" from other expenses. That separate
  listing (a separate account or column, R 4.11 paragraph 1 of the income tax
  guidelines) is a record under paragraph 1 number 1: **10 years**. In this app the
  meal register's amounts are that listing. It does not need the guests' names.
- **When the period starts (section 147 paragraph 4):** at the end of the calendar
  year in which the voucher arose, so for a meal on 14 March 2025 the guest list may
  go after 31 December 2033, the register's amounts after 31 December 2035.
- **When it does not end (section 147 paragraph 3 sentence 5):** not while the
  documents matter for a tax whose assessment period is still open (an audit, an
  objection, a provisional assessment).

What this means for `src/lib/erasure.ts` once the confirmation is recorded:
`retainUntilFrom(now)` would become "31 December of the meal's year plus 8 years",
computed from the meal's date rather than from the day of erasure, and a held copy of
a year that is still open (provisional assessment, audit) would not be purged. The
uncertainty a lawyer or tax advisor should settle: whether anyone treats the written
meal record itself as a record under number 1 (10 years). No statute, ministry letter
or court decision found says so, and the letter's "join it to the invoice" supports 8
years. Keeping 10 years removes that risk but holds personal data of guests two years
longer than required, which data protection law (storage limitation, Article 5
paragraph 1 letter e of the General Data Protection Regulation) weighs against.
