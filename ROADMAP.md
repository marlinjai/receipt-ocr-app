# Roadmap

## Planned

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
