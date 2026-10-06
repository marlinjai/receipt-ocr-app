# Roadmap

## Planned

<!-- Decided features, ready to be worked on -->

- [ ] Bank connection and item-level receipts: write the plan (status draft) before any
  code. Scope: (1) link bank accounts through Enable Banking, using the registered
  application "Lumitra Receipts" (id `306d872b-bf50-4a18-95cb-3f17790470b7`, restricted
  production, which only returns data for accounts linked to the application itself, so
  it serves the operator's own accounts only; key and the four session ids are in
  Infisical, project Receipt OCR, as `ENABLE_BANKING_*`), plus importers for sources with no usable interface: Advanzia
  statement PDFs, the Klarna purchase list and N26's own export (the bank interface
  omits recipient names); (2) a payments table with categories, counting each payment
  where it was spent and excluding settlements (Klarna debits, Advanzia repayments,
  transfers between own accounts); (3) line items per receipt with sub-categories;
  (4) linking receipt to payment by payment reference, never by merchant name or amount
  (the Klarna app mislabels merchants and adds fees), and a "payments without a receipt"
  list. Before building, confirm per source whether Enable Banking's `entry_reference`
  is the reference field and how well it is covered: some banks omit it or return
  duplicates, and it is usually set only for booked (not pending) transactions, so
  match booked transactions only. Define the fallback for a payment without a unique
  reference (manual link by the user, never a guess from merchant or amount);
  (5) before anyone but the operator links a bank account: a Receipts section in the
  lumitra.co privacy policy AND public Enable Banking access (signed contract and
  completed company KYB, i.e. know-your-business verification); (6) track each
  session's `valid_until` (at most 180 days for most banks) and warn users before it
  expires so they can reauthorize, and handle `EXPIRED_SESSION` by prompting a new
  authorization.
  Must fit the Books plan (`docs/plans/2026-08-15-books-integration-pointer.md`).
  A validated prototype (matching, ledger, categories) is in
  `~/Library/Mobile Documents/com~apple~CloudDocs/Documents/personal/Finance/Banking/_pipeline-2026-10/`. (2026-10-03)

- [ ] Migrate the `/api/*` `SERVICE_TOKEN` machine path to tenant-scoped auth-brain
  API keys. Deferred out of the app-grant door flip (that slice left the shared
  `SERVICE_TOKEN` bearer unchanged); machine callers should carry a
  tenant-scoped key so their access is entitlement-checked like browser sessions. (2026-09-10)
- [ ] Deploy Docs GitHub Actions workflow has failed on every run since at least
  2026-08-03 ("Missing universal auth credentials": the Infisical secrets-action
  step wants `INFISICAL_CLIENT_ID`/`INFISICAL_CLIENT_SECRET` as repo secrets, which
  this repo does not have). Two real options: (1) provision the two Infisical
  secrets on this repo, or (2) retire the standalone docs site and switch to the
  satellite `docs-trigger.yml` pattern used by other repos (needs changes in the
  hub ERP-suite repo too). Needs Marlin to decide which docs site survives and
  either provision a secret or make the hub-repo change. (2026-09-10)
- [ ] The dashboard workspace dropdown still lists a drained legacy workspace
  labeled "Lola Stories" whose data was migrated away (leftover from the PR #18
  app-grant gating cleanup). The ambiguous-label half of this is fixed (adopting
  the shared `WorkspaceSwitcher` from `auth-brain-nextjs` 0.4.1 now labels a
  single-workspace company by its company name instead of a bare "Main"); what
  remains is hiding or deleting the drained legacy workspace membership, which is
  a production data change/audit in the auth-brain multi-tenant service, not a
  code fix in this repo. Needs Marlin or a data audit before touching it. (2026-09-10)

## In Progress

<!-- Currently being implemented -->

- [ ] Business-meal register (Bewirtungsverzeichnis) and phone capture: record guests
  (from a contact list), occasion, place, tip and host per meal, derive completeness
  and the 70 percent deductible amount, export the register per year as PDF
  (Portable Document Format) and CSV (comma-separated values), and add camera
  capture, a share target and an offline queue on the phone. Plan approved and
  decided on 2026-10-06, in progress as two pull requests (slices 1 to 3, then 4 to
  6): `docs/plans/2026-10-06-meal-register-and-phone-capture.md`. Backlog waiting on
  it: 17 meal receipts from 2025 and about 15 from 2026 without guests or occasion.
  (2026-10-06)

## Completed

<!-- Done — move to CHANGELOG.md on release -->

- [x] Branch the Drive-attach and Drive-browse 403 error mapping on Google's
  error body so an API-disabled GCP (Google Cloud Platform) project gets its own
  `drive_api_disabled` code/label instead of the misleading "reconnect Google"
  advice meant for a genuine missing-scope 403. (2026-09-10)
