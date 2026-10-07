# Roadmap

## Planned

<!-- Decided features, ready to be worked on -->

- [ ] Finance and tax dashboard, stage 1 (data foundation and live dashboard): draft
  plan, waiting for the owner's approval before any code. Seven slices: tax rules per
  year and the income-surplus statement from receipts, assets and receipt lines,
  payments (file imports and the Enable Banking daily sync, matching by reference,
  payments without a receipt), revenue by payment date, the income tax estimate, the
  year-end entry sheet with a filed-year snapshot, and a mail-in address. This line
  absorbs the earlier "Bank connection and item-level receipts" item; its facts
  (registered application, session rules, import sources, the two gates before anyone
  but the operator links an account) are in the plan's "Bank data" section. Plan:
  `docs/plans/2026-10-07-finance-tax-dashboard-and-advisory.md`. (2026-10-07)
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

- [x] Branch the Drive-attach and Drive-browse 403 error mapping on Google's
  error body so an API-disabled GCP (Google Cloud Platform) project gets its own
  `drive_api_disabled` code/label instead of the misleading "reconnect Google"
  advice meant for a genuine missing-scope 403. (2026-09-10)
