# Roadmap

## Planned

- [ ] Company erasure hands over an export first. Decided 2026-10-09 (Marlin): build B. When a
  company is deleted, its register and contacts go into a zip that the company keeps. Printed guest
  names are held for ten years (German tax law, the Abgabenordnung, AO) when no export was taken,
  and removed at once when one was. Needs: an export route for members who can write the register,
  a record of each export, a hold date on printed copies, and a scheduled purge of held copies.
  Until built, a company deletion removes printed guest names with no export, so export a
  company's register by hand before deleting it. Work in progress parked on the local branch
  `feat/erasure-export-handover` (not pushed). (2026-10-09)

<!-- Decided features, ready to be worked on -->

- [ ] Finance and tax dashboard, stage 2 (scenario engine): "what if I buy X on date
  Z at share S" and "what if revenue is R", computed by the same tax module as the
  dashboard, saved as inputs and never as results. After stage 1. Plan:
  `docs/plans/2026-10-07-finance-tax-dashboard-and-advisory.md`. (2026-10-07)
- [ ] Finance and tax dashboard, stage 3 (advisory layer): deterministic hints that
  each show inputs, rule, source and euro effect, the legal form comparison (sole
  proprietor against a company with limited liability or a partnership) with a
  hand-off to a tax advisor, and last an optional language model that may only quote
  computed figures. Operator only until a lawyer's opinion on the tax advisory act
  and public bank data access exist. After stage 2. Plan:
  `docs/plans/2026-10-07-finance-tax-dashboard-and-advisory.md`. (2026-10-07)

- [ ] Extraction defects found in the first live upload (2026-10-08, a 21-page scan of
  restaurant receipts uploaded with "One receipt per page"): (1) a receipt number was read
  as the total (916,752.88 instead of 61.40), so a total needs a plausibility check against
  the line items and the tax lines; (2) tax rates come out as nonsense (526.37, 844.06)
  when the net amount is misread; (3) 2 of 21 pages were saved as an empty "Receipt" row
  with no vendor, date or amount and no hint that reading failed; (4) a bar receipt was
  categorised as software and a restaurant receipt as "other", so neither reached the meal
  queue; (5) vendor names are taken from the first printed line ("Since 2016", "+ mit
  Haferdrink", "Indisches") instead of the business name; (6) the look-alike prompt was
  lost when the upload page was left, and the duplicate stayed saved without a trace in
  the queue; (7) the meal register year picker offers only the current year until a meal
  is complete, so a prior-year backlog looks empty. (2026-10-08)
- [ ] Deleting a receipt in the dashboard table leaves its stored file behind: `deleteRow`
  and `bulkDeleteRows` in `src/app/app/dashboard/actions.ts` remove the row, its file
  references and its guests, but never the object in the file store (the table's file
  adapter treats deletion as reference-only on purpose). The meals page now deletes
  the stored file too (`deleteReceiptRows` in `src/lib/meals/service.ts`, file first,
  row second, shared files kept). Needs the owner's decision whether the dashboard
  should delete for good the same way; if yes, route both dashboard actions through
  `deleteReceiptRows`. Found on 2026-10-08 while building the batch actions. (2026-10-08)
- [ ] The production database `receipts-postgres` on Coolify has no backup schedule at
  all (checked 2026-10-09 through the Coolify interface: zero schedules). It holds the
  receipts, the business-meal register and the tax figures. Needs the owner's decision
  on frequency, retention and where the dumps are kept (on the server only, or also in
  object storage); then one schedule on that database and one restore tried from it.
  Found while repairing the doubled meal columns, which removes columns from a live
  table. (2026-10-09)
- [ ] Three defects in the shared table adapter (`@marlinjai/data-table-adapter-prisma`
  0.2.1) that this app now works around and that belong fixed there: (1) nothing stops
  two columns of one table from carrying the same name, so a check-then-create race
  doubles a column (here: a per-workspace lock in `ensureReceiptsTable`; there: a unique
  index on table and name, or a lock in `createColumn`); (2) `getRow` reads with a
  prepared `SELECT *` and swallows every error, so after any column was added or
  dropped Postgres answers "cached plan must not change result type" and the adapter
  reports "Row not found" (here: `statement_cache_size=0` in `src/lib/prisma-url.ts`;
  there: list the columns, and let the error through); (3) `updateRow` silently skips a
  cell whose column it does not know and still reports success. (2026-10-09)
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

- [ ] Contact screen, wave 3: the Kontakte tab manages organizations with address, legal form and
  VAT ID, links people to organizations, merges duplicates, assigns customer numbers and exports one
  contact. Erasing one contact shows but is not available until the company erasure build lands; custom
  fields and the preferred contact method wait for contacts-core 0.2.0. Plan:
  `docs/plans/2026-10-09-contact-screen.md`. (2026-10-09)

## In Progress

<!-- Currently being implemented -->

- [x] Shared contact list, wave 2: the business-meal guests moved to the suite's shared
  contacts database (company-scoped, behind the `CONTACTS_STORE=shared` switch, default
  off), with a merge-aware data move that Marlin reviews before anything is dropped. Done
  2026-10-09: the switch is on in production. Waves 3 to 5 are open in the knowledge-base
  roadmap. Plan: `docs/plans/2026-10-09-shared-contacts-wave2.md`. (2026-10-09)
- [ ] Finance and tax dashboard, stage 1 (data foundation and live dashboard): slice 1
  of 8 is built (the tax module with rule sets for 2025 and 2026, shares for several
  purposes per receipt, vendor rules, the queue of open checks and the
  income-surplus statement at `/app/finance`). Next: slice 2, assets and receipt
  lines. Then payments (file imports and the Enable Banking daily sync, matching by
  reference), revenue with a forecast of the small-business limits, regular
  value-added taxation, the income tax estimate, the year-end entry sheet, reading
  the expenses mailbox. Open inside slice 1, each described in the plan's "Reality
  after slice 1": (1) the two older receipt columns "Business Share %" and
  "Zuordnung" and the per-vendor share table of the overview page are still read as
  a starting point and are removed only after the owner has finished entering the
  2025 meals and the session preparing the 2025 return has been told; (2) the line
  numbers of the 2026 form and of the employment annex are not yet compared with
  the official forms, so the app shows those lines without numbers; (3) the 2027
  rule set is due before 1 December 2026, when a test starts failing without it.
  Plan: `docs/plans/2026-10-07-finance-tax-dashboard-and-advisory.md`. (2026-10-07)
- [ ] Business-meal register (Bewirtungsverzeichnis) and phone capture: all six
  slices are built (register, contact list, export, duplicate checks, page split,
  phone capture, classifier, offline queue, service worker, share target). Left
  before this can be ticked: (1) a pass by hand on a real phone (camera,
  home-screen install, offline queue) and one real upload through text recognition
  in production; (2) the owner's decision whether to keep the share target, which
  only works on Android (it is the last commit of the second pull request and can
  be reverted on its own); (3) confirm with the tax advisor the amount above which
  the receipt must name the host (set to 250 euros). Plan:
  `docs/plans/2026-10-06-meal-register-and-phone-capture.md`. (2026-10-07)
  - [x] Batch actions on the meals page, asked for after the first real use with 17
    open entries: a checkbox per entry and "select all" in the queue, a batch bar with
    "Keine Bewirtung" (out of queue and register, kept as a receipt, taken back from
    the new "Keine Bewirtung" list on the same page) and "Löschen" (row, stored file
    and guests, after an in-page confirmation), the same two actions on a single
    queue entry and on a register entry. A batch finishes the rest when one receipt
    is gone or belongs to another workspace, and a receipt whose stored file cannot
    be deleted is kept and reported. (2026-10-08)
  - [x] Visual polish of the meals page after the owner's review of the batch actions:
    a reusable custom checkbox (`src/components/ui/Checkbox.tsx`, real input, mixed
    state, 40 pixel hit area), no layout shift when an entry is checked (the batch bar
    has a reserved slot under the queue, outcome notices float, rows are a fixed grid; measured
    0 pixels at desktop and phone width), thin on-brand scroll bars and the dark colour
    scheme app-wide, quieter row actions, a destructive button that looks destructive
    at rest. Checked in a headless browser with screenshots. (2026-10-08)
  - [x] Receipt viewer and form fixes from the owner's live use: the receipt beside the
    form can be turned in quarter steps (stored with the file reference, so it is the
    same in the dashboard and on the exported register sheet; the stored file is never
    rewritten), zoomed, dragged and fitted, with keys R, plus, minus and 0. A PDF
    receipt is drawn to a picture in the browser (new dependency `pdfjs-dist`), so a
    sideways scan no longer sits as a strip in a browser frame. The place field opens
    with name and address read from the receipt text when a complete address is found
    there ("Aus Beleg übernehmen" for receipts that already have a place), and picking
    the host from browser autofill no longer overwrites the place. (2026-10-08)

## Completed

<!-- Done — move to CHANGELOG.md on release -->

- [x] A newly created Receipts table now carries its company from the first moment
  (`ensureReceiptsTable` and the dashboard's `createTable` stamp it right after
  creation, never overwriting an owner), with a database test. Before, a workspace
  created after the tenant backfill stayed without a company until the backfill was
  run again. (2026-10-07)
- [x] Branch the Drive-attach and Drive-browse 403 error mapping on Google's
  error body so an API-disabled GCP (Google Cloud Platform) project gets its own
  `drive_api_disabled` code/label instead of the misleading "reconnect Google"
  advice meant for a genuine missing-scope 403. (2026-09-10)
