---
title: Auth-brain multi-tenant integration (receipt-ocr-app) + @marlinjai/auth-brain-nextjs extraction
summary: Wire the receipt-ocr-app (currently zero authentication) into auth-brain with full multi-tenant isolation for three real companies (Lola Stories, marlinjai freelance, Lumitra), by first extracting the proven lumitra-studio integration seam into a shared @marlinjai/auth-brain-nextjs package, then consuming it. Includes Lola Stories tenant promotion, per-workspace data partitioning, migration of existing data, and suite governance follow-ups.
type: plan
tags: [auth, auth-brain, openfga, multi-tenant, receipt-ocr, sdk, nextjs, governance]
projects: [receipt-ocr-app, auth-brain, lumitra-studio, analytics-platform]
status: in-progress
date: 2026-07-16
---

# Auth-brain multi-tenant integration for the Receipt OCR App

**Status:** Decided 2026-07-16 (direction confirmed by Marlin in session; execute end to end).
**Primary repos:**
- `/Users/marlinjai/software-dev/ERP-suite/projects/receipt-ocr-app` (the consumer being secured)
- `/Users/marlinjai/software-dev/ERP-suite/projects/lumitra-infra/auth-brain` (identity service monorepo; new `packages/nextjs` lands here)
- `/Users/marlinjai/software-dev/ERP-suite/projects/lumitra-studio` (donor of the proven integration code; refactored onto the shared package in Phase 5)

## 1. Context and problem

`receipts.lumitra.co` (Next.js 16, Postgres via Prisma + `@marlinjai/data-table-adapter-prisma`, Docker on Coolify via GHCR; the `wrangler.jsonc` Cloudflare config is vestigial) has **no authentication whatsoever**: no middleware, no auth dependency, no env gate. It now stores real vendor invoices, salaries, and payment data. It has been on the auth-brain consuming-app migration queue since 2026-06 ("not started, needs auth audit").

Marlin confirmed the app is needed by **three real companies**, which locks the decision to the full multi-tenant pattern (not the coarse single-workspace gate):

1. **Lola Stories** (co-founded with Leon Gruchmann)
2. **marlinjai freelance** (Marlin's freelance business)
3. **Lumitra** (the tools/infra company itself)

### The suite mental model (settled in-session, write it down once)

- **Tenant = company.** Spans the entire suite. Lola Stories is ONE tenant whether it's touching receipts, analytics, or storage-brain.
- **Workspace = a scope inside a company**, typically one per app-usage-context ("Lola Stories' receipts workspace", "Lola Stories' analytics-project-X workspace").
- **Apps are neither tenants nor workspaces.** They are relying parties that ask auth-brain "is this principal a member of THIS workspace" and enforce locally.
- App-internal columns that reference auth-brain workspaces must be named `authWorkspaceId` to avoid the known studio/storage-brain vocabulary collision.

### Findings that shape this plan (verified 2026-07-16, not assumptions)

- The machine admin API **already has GET/list endpoints** for tenants, workspaces, and orgs (auth-brain PR #37). The old "no list endpoints" memory is stale. `memberships` is still POST/DELETE only — a Phase 6 gap.
- The SDK (`@marlinjai/auth-brain-sdk@1.2.0`) ships a **Hono** middleware but **no Next.js integration**. The Next.js seam (verifyRequest / membership gate / login redirect / `guardMutation`) exists only as hand-copied code in lumitra-studio and analytics-platform. That duplication already caused two production incidents (SDK 1.0.0 pin sending no OpenFGA bearer → every analytics check silently 401'd fail-closed; stale OpenFGA model-id pins). Extraction is the highest-leverage move and Marlin explicitly approved it.
- Lola Stories currently exists as a **workspace under tenant `lumitra-core`** (from the 2026-07-10 storage-brain cutover), with service account `lola-stories-api` and the storage-brain tenant bound via `authWorkspaceId`. Under the settled model it must be **promoted to its own tenant** (Phase 2), which touches the storage-brain binding.
- receipt-ocr-app's data layer is *already* partitioned by a `workspaceId` column (`dt_tables.workspace_id` in the dynamic data-table schema) — it's just hardcoded to the string `'receipt-ocr'` in two places (`src/lib/receipts-constants.ts:29` and a local const in `src/app/app/actions.ts:18`). Multi-tenant isolation therefore needs **no schema migration**: point the constant at the session's matched auth-brain workspace id instead.
- `initializeReceiptsTable()` was rewritten to be idempotent/self-healing on 2026-07-15 (receipt-ocr-app PR #3). Per-workspace lazy table creation falls out of that for free.

## 2. Target architecture

```
Browser ── lumitra_session cookie (.lumitra.co) ──▶ receipts.lumitra.co middleware
                                                        │ verifyRequest()  (auth-brain-nextjs)
                                                        │   ├─ Authorization header? → SERVICE_TOKEN compare → {service}
                                                        │   └─ cookie → auth.lumitra.co verifySession (30s cache)
                                                        │        └─ match workspaces[] by slug prefix "receipts-"
                                                        │             ├─ 0 matches → /no-access
                                                        │             └─ ≥1 match → {user, memberships[], activeWorkspace}
                                                        ▼
                                             active workspace (cookie `receipts_ws`,
                                             validated against memberships every request)
                                                        ▼
                                    data layer: dt_tables WHERE workspace_id = activeWorkspace.id
                                                        ▼
                          mutating server actions/routes: guardMutation('receipts.<action>')
                                    → OpenFGA can(user, workspace.member, workspace) — fail-closed
```

### Tenancy provisioning target state

| Tenant (company) | Receipts workspace slug | Members |
|---|---|---|
| `lola-stories` (promoted to own tenant in Phase 2) | `receipts-lola-stories` | marlin@lolastories.com (Leon addable later via console, no code change) |
| `marlinjai` (freelance; NEW) | `receipts-marlinjai` | marlin@lolastories.com |
| `lumitra` (NEW — distinct from the infra-identity tenant `lumitra-core`) | `receipts-lumitra` | marlin@lolastories.com |

Workspace slugs use the `receipts-<company>` prefix convention so the app can match "all my receipts workspaces" by prefix without baking UUIDs into the build (same slug-not-UUID principle as studio's `STUDIO_WORKSPACE_SLUG`).

### Data mapping

- `dt_tables.workspace_id` := the **auth-brain workspace UUID** (not the slug — slugs are for session matching only, ids are stable).
- One `Receipts` table per workspace, lazily created by the idempotent `initializeReceiptsTable(workspaceId)` on first visit.
- The existing legacy data-table workspace `'receipt-ocr'` (all current rows: Marlin's personal/freelance receipts, Zuordnung Universität/Geschäftlich/Privat) migrates to the `receipts-marlinjai` workspace id (Phase 4).
- The `Project` select column **stays** as within-workspace sub-tagging (the freelance workspace still needs per-client tags). It is no longer the company boundary — the workspace is.

### Permission vocabulary (receipt-ocr-app)

All map to `workspace.member` today; the map exists so call sites never change when granularity tightens later (same pattern as `STUDIO_PERMISSIONS`).

| Action | Requirement | Gates |
|---|---|---|
| `receipts.upload` | `workspace.member` | `processReceipt` (OCR ingest + row create) |
| `receipts.row.write` | `workspace.member` | row create/update/delete/archive via the dashboard server-actions adapter |
| `receipts.schema.write` | `workspace.member` (candidate for `workspace.admin` later) | column/view/select-option mutations |
| `receipts.fx.recompute` | `workspace.member` | the FX date-range batch action |

## 3. Phases

Execute in order. Each phase ends with its verification gate green before the next starts. Phases 1 and 2 are independent and may run in parallel if convenient.

---

### Phase 1 — Extract `@marlinjai/auth-brain-nextjs` (auth-brain monorepo)

**Home:** new `packages/nextjs` in the auth-brain monorepo (`~/software-dev/ERP-suite/projects/lumitra-infra/auth-brain`), published as `@marlinjai/auth-brain-nextjs@0.1.0` with `publishConfig.access: public`. Depends on `@marlinjai/auth-brain-sdk` (^1.2.0) + `@marlinjai/auth-brain-shared`; `next` is a peer dependency (>=15).

**Naming note:** the package-naming standard's role-suffix vocabulary doesn't include `-nextjs`; it's a platform-binding suffix exactly analogous to the allowed `-react`. Add a one-line addendum to `~/software-dev/knowledge-base/standards/package-naming.md` legalizing `-nextjs` (and note `nextjs-auth0` as the industry precedent) in the same PR. Do not silently violate the standard.

**Source material:** lift, generalize, and de-studio-ify these proven files from `lumitra-studio/src/lib/auth/` (they are the battle-tested implementation — preserve semantics exactly, especially the fail-closed contracts and the Authorization-header-never-falls-through-to-cookie precedence):

| Donor (lumitra-studio) | Becomes |
|---|---|
| `verifyRequest.ts` | `createVerifyRequest(config)` — resolves `{kind:'user',email,userId,memberships,activeWorkspace} \| {kind:'service'} \| {kind:'none',reason}` |
| `workspace.ts` | workspace matching, generalized: `{ slug: string }` (studio mode, one workspace) OR `{ slugPrefix: string }` (receipts mode, N workspaces) |
| `can.ts` | `definePermissions map` + `guardMutation(action, opts)` — fail-closed (thrown OpenFGA error AND `false` are both deny) |
| `session.ts` | `getSession()` / `requireSession(returnTo)` server-component helpers |
| `loginRedirect.ts` | `loginUrl(returnTo)` / `logoutUrl()` |
| `middleware.ts` (app-level) | `createAuthMiddleware(config)` — returns the Next.js middleware function (pass-through / JSON 401/500 for `/api/*` / login redirect / `/no-access`), with `publicPaths` config |

**New capability the donor lacks (the only genuinely new code): multi-workspace + active-workspace selection.**
- `verifyRequest` in prefix mode returns ALL matched workspaces as `memberships[]`.
- Active workspace = value of a configurable cookie (`activeWorkspaceCookie`, receipt-ocr uses `receipts_ws`), validated against `memberships` on EVERY request; invalid/absent falls back to the first membership (deterministic: sorted by slug). Never trust the cookie value itself — it's a selector into the verified set, not a credential.
- Export a `setActiveWorkspace` server-action helper for the switcher UI.

**Also preserve:** the `SERVICE_TOKEN`/`SERVICE_TOKEN_NEXT` constant-time dual-accept rotation compare, the 30s verify cache, dev bypass (`AUTH_DEV_USER_EMAIL`, dev-only, skips membership + can()), lazy env reads (build must not crash without env), and never-log-credentials.

**Config surface (single entry point):**

```ts
export const auth = createAuthBrainNextjs({
  appName: 'receipts',
  workspaces: { slugPrefix: 'receipts-' },      // or { slug: 'lumitra-studio' }
  activeWorkspaceCookie: 'receipts_ws',          // only meaningful in prefix mode
  permissions: { 'receipts.upload': 'workspace.member', /* ... */ },
  publicPaths: ['/api/health', '/no-access'],
  // env-read defaults (all lazy): AUTH_BRAIN_URL, OPENFGA_API_URL/STORE_ID/
  // AUTHORIZATION_MODEL_ID/API_TOKEN, SERVICE_TOKEN(_NEXT), AUTH_DEV_USER_EMAIL
});
```

**Tests:** port lumitra-studio's DB-free vitest middleware suite (`vitest.middleware.config.ts` specs: verifyRequest precedence, membership gate, fail-closed can(), token rotation, dev bypass) into the package, plus new specs for prefix matching and active-workspace cookie validation (cookie pointing at a non-member workspace must fall back, not 403-loop).

**Publish:** `pnpm pack` locally → publish via the secrets-proxy npm flow (laptop `~/.npmrc` token is dead; `NPM_TOKEN` lives in the dotfiles Infisical project `9af620f0`, env dev, root path — see storage-brain memory for the exact working procedure).

**Verification gate:** package vitest suite green; `pnpm build` of the monorepo green; package visible on npm with correct access.

---

### Phase 2 — Tenant provisioning + Lola Stories tenant promotion (auth-brain, operator work)

All calls go through the machine admin API (`https://auth.lumitra.co/api/admin/machine/*`, Bearer `ADMIN_API_KEY`). **The admin key must never enter Claude's context** — run every call through `execute_with_secrets` (secrets proxy), with the key injected from the auth-brain Infisical project (`97c4971e`, prod). GET/list endpoints exist for tenants/workspaces/orgs (PR #37) — use them to inspect current state before and after every mutation.

**2a. Promote Lola Stories to its own tenant.** Current state: workspace `lola-stories` under tenant `lumitra-core`, service account `lola-stories-api` (role member), storage-brain tenant `lola-stories` bound via `authWorkspaceId`, key live as `STORAGE_BRAIN_API_KEY` in lola-stories Infisical prod `/apps/api`.

1. GET current tenants + workspaces; record ids (ground truth, not memory).
2. Create tenant `lola-stories`.
3. Create workspace (slug `lola-stories`, for the storage-brain binding) under the new tenant. **First verify whether workspace slugs are globally unique or per-tenant** (read `packages/app` route/schema code) — if global, the old workspace must be deleted before the new one can take the slug, which changes the order of operations below.
4. Re-point the storage-brain binding: update the SB tenant's `authWorkspaceId` to the new workspace id (SB admin API; agent-driven pattern in `reference_storage_brain_admin_via_agent.md`).
5. Recreate the service account under the new workspace. **Known gotcha:** recreation re-emits the OpenFGA tuple event (this is how the dead-lettered-tuple problem was fixed on 2026-07-10) — recreation is the intended path, not a workaround. A new SA means a new API key: upsert as `STORAGE_BRAIN_API_KEY` in lola-stories Infisical prod `/apps/api` **via the proxy write path with the Lola-org credentials** (`INFISICAL_LOLA_CLIENT_ID/SECRET`, NOT `SECRETS_PROXY_*` which is Lumitra-org and 403s — see `reference_lola_org_proxy_write.md`), then redeploy the lola-stories API.
6. Verify: SB key verifies 200 against prod; lola-stories app boots and can reach storage-brain; membership checks pass.
7. Delete the old workspace under `lumitra-core` only after step 6 soaks green.

**2b. Create the remaining tenants + receipts workspaces + memberships** (per the target-state table in §2): tenants `marlinjai`, `lumitra`; workspaces `receipts-lola-stories`, `receipts-marlinjai`, `receipts-lumitra`; invite/membership for marlin@lolastories.com on all three (owner/admin role).

**Verification gate:** GET tenants/workspaces shows the target state; `verifySession` for Marlin's session returns all three receipts workspaces in `workspaces[]` (checkable via a logged-in curl to auth-brain or via the first Phase-3 smoke test).

---

### Phase 3 — receipt-ocr-app integration (the consumer)

Branch + PR on `receipt-ocr-app`, consuming `@marlinjai/auth-brain-nextjs@0.1.0`.

1. **`src/lib/auth.ts`** — the single `createAuthBrainNextjs` config (§2 snippet above), permissions map with the four `receipts.*` actions.
2. **`src/middleware.ts`** (new) — `export default auth.createAuthMiddleware()`; public paths `/api/health` + `/no-access`. Everything else — pages AND `/api/*` (ocr, chat, classify-single, upload/*, files/*) — requires a verified session with ≥1 receipts workspace, or a valid `SERVICE_TOKEN` bearer.
3. **`/no-access` page** (new, public): "ask Marlin to invite you", logout link.
4. **Thread the active workspace through the data layer.** Kill both hardcoded `WORKSPACE_ID` constants. `getTableId()` in `src/app/app/actions.ts`, `initializeReceiptsTable()`, the dashboard `page.tsx` lookup, and the raw CRUD server actions in `src/app/app/dashboard/actions.ts` all take the verified `activeWorkspace.id` resolved server-side per request (NOT client-supplied — the server-actions adapter must re-resolve the session, never accept a workspaceId argument from the browser).
5. **`guardMutation` on every mutating path:** `processReceipt` (`receipts.upload`), `recomputeFxRates` (`receipts.fx.recompute`), all row-writing server actions (`receipts.row.write`), all column/view/select-option writes (`receipts.schema.write`). Read paths need session + membership only (the middleware gate).
6. **Workspace switcher UI** in the dashboard header: dropdown of `memberships` (slugs prettified), sets the `receipts_ws` cookie via the package's `setActiveWorkspace` action, refreshes. Also show the active company name prominently — a finance tool must never be ambiguous about whose books you're looking at.
7. **Upload flow check:** `/api/upload/request` + `/api/upload/complete` + `/api/files/*` sit behind the middleware now; confirm the client fetches carry the cookie (same-origin — they do) and that file GETs used in `Receipt Image` cells still render for logged-in users.
8. **Env:** add to receipt-ocr-app Infisical project (`95d42533-3157-4b66-a49b-cc386ec1214d`), prod: `AUTH_BRAIN_URL` (optional, defaults), `OPENFGA_API_URL`, `OPENFGA_STORE_ID`, `OPENFGA_AUTHORIZATION_MODEL_ID`, `OPENFGA_API_TOKEN`, `SERVICE_TOKEN` (fresh ≥32 chars). Scaffold as PLACEHOLDER via the split-responsibility pattern; Marlin fills real values (OpenFGA values can be proxy-copied from the studio/auth-brain Infisical projects server-side — values never enter context). **Use the CURRENT OpenFGA model id** (`01KX6DHTRW9D4GA3QCW3A1N2PG` per the 2026-07-10 storage-brain session — verify against auth-brain Infisical prod at execution time, don't trust this doc), not the stale id studio/analytics still pin.
9. **Dev:** `AUTH_DEV_USER_EMAIL` in Infisical dev env; document in README that local dev bypasses auth by design.
10. **Tests:** vitest specs for the server-side workspace resolution (active-workspace cookie tampering falls back safely; a user with zero receipts workspaces gets `/no-access`; service bearer passes; mutating action without membership is 403).

**Verification gate:** `pnpm exec vitest run`, `tsc --noEmit`, `pnpm build` green; deployed to Coolify; **live smoke test:** (a) logged-out browser → redirected to auth.lumitra.co login → back → dashboard loads; (b) switcher shows all three companies; (c) upload a receipt into `receipts-lumitra`, confirm it does NOT appear in `receipts-marlinjai`; (d) curl `/api/ocr` with no auth → 401, with `SERVICE_TOKEN` → 200; (e) `/api/health` public.

---

### Phase 4 — Data migration + backfill

1. **Migrate legacy rows:** one idempotent script (`scripts/migrate-workspace-id.ts`, run via `infisical run` against prod DB) that re-points the existing data-table workspace: `UPDATE dt_tables SET workspace_id = '<receipts-marlinjai uuid>' WHERE workspace_id = 'receipt-ocr'` (single row — the dynamic schema hangs everything else off `dt_tables.id`, so this one UPDATE moves the whole table). Verify row counts before/after; keep the old value in the script output for rollback.
2. **Lola Stories vendor-invoice backfill** (Phase 4 of the 2026-07-13 vendor-invoice plan, still pending): upload the ~53 Drive-folder invoice PDFs into the `receipts-lola-stories` workspace through the now-authenticated app. Keep the manual Google Sheet/dashboard running in parallel (decided 2026-07-13: parallel-run, don't retire).
3. Confirm the per-workspace `initializeReceiptsTable` created fresh tables for `receipts-lola-stories` / `receipts-lumitra` with the full column set including the 2026-07-15 currency/FX/attribution columns.

**Verification gate:** freelance workspace shows exactly the pre-migration rows; Lola workspace totals reconcile against the Google Sheet Summary tab (€1,252.27 combined as of 2026-07-15).

---

### Phase 5 — Refactor lumitra-studio (and optionally analytics-platform) onto the shared package

The point of extraction is killing the copies. Studio first (its code IS the donor, so the diff is mechanical): replace `src/lib/auth/*` with the package in single-`slug` mode, keep `STUDIO_PERMISSIONS` as the app-side map, run its existing middleware vitest suite unchanged (it mocks at the seam — if the package preserves semantics, the suite passes). Bump studio's pinned OpenFGA model id to current while in there. Analytics-platform is a bigger diff (its shim layer differs) — do it as a follow-up PR with the same recipe, not in this plan's critical path.

**Verification gate:** studio middleware suite green; studio deployed; login + generate smoke test on studio.lumitra.co.

---

### Phase 6 — Suite governance (small, do not skip — no-open-ends rule)

1. **App registry:** `docs/internal/consuming-apps.md` in the auth-brain repo — one table: app, domain, SDK version, auth-brain-nextjs version, OpenFGA model id pinned, workspace slugs/prefixes used, Infisical project id. Seed with auth-brain itself, studio, analytics, storage-brain, receipt-ocr-app, framer-clone.
2. **Bump checklist:** short standard in `~/software-dev/knowledge-base/standards/` — "when the SDK or the OpenFGA model bumps, walk the registry and bump every consumer within a week." Process, not tooling.
3. **`memberships` GET endpoint** on the machine admin API (the one remaining list gap) — small auth-brain PR.
4. **Package-naming addendum** for `-nextjs` (if not already landed with Phase 1).
5. Update the stale analytics-platform memory (`project_auth_brain_integration_state.md`): receipt-ocr-app row → done; "no list endpoints" note → corrected.

## 4. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Lola tenant promotion breaks storage-brain auth for the live lola-stories app | Phase 2a is strictly ordered (new binding verified before old workspace deleted); SB legacy-key path stays valid as fallback (still un-revoked per 2026-07-10 memory); soak before delete. |
| Workspace-slug uniqueness scope unknown (global vs per-tenant) | Read the auth-brain schema/route code FIRST (step 2a.3); it changes the promotion order, not the destination. |
| Middleware locks Marlin out of a finance tool if auth-brain is down | Same availability trade-off studio/analytics already accepted; `verifyRequest` maps SDK errors to 500-with-reason (not a silent 403), and the data is also in the parallel-run Google Sheet. Acceptable. |
| Client-supplied workspace id spoofing | The server-actions adapter NEVER accepts workspaceId from the browser; the active-workspace cookie is only a selector validated against the server-verified membership set. |
| OpenFGA env missing/wrong in prod → everything denied | Fail-closed is intended; smoke test (d) catches it at deploy time. Copy the four OPENFGA_* values from a known-good project (studio) via proxy. |
| npm publish friction (dead laptop token) | Use the documented proxy publish path (storage-brain memory, 2026-07-10). |

## 5. Explicitly out of scope

- OIDC/general-purpose SSO beyond the `.lumitra.co` cookie domain.
- Per-resource physical isolation (tenant-db) and role granularity beyond `workspace.member` (the permissions map is the future seam).
- An in-app member-invite UI (auth-brain console owns membership).
- Retiring the manual Lola Stories Google Sheet (parallel-run decision stands).
- framer-clone / email-editor migrations (same recipe later; registry tracks them).
