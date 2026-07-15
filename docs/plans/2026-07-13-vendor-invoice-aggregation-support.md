---
title: Vendor/SaaS Invoice Aggregation Support (multi-currency, shared-subscription attribution)
summary: Extend the Receipt OCR App so it can natively replace the manual Lola Stories SaaS-vendor invoice pipeline (Google Sheet + static dashboard), adding currency detection, historical FX conversion, per-vendor shared-expense attribution percentages, and project tagging.
type: plan
tags: [receipt-ocr, invoices, currency, fx, attribution, lola-stories, saas-billing]
projects: [receipt-ocr-app, lola-stories]
status: decided
date: 2026-07-13
---

# Vendor/SaaS Invoice Aggregation Support

**Date:** 2026-07-13
**Status:** Decided, all open questions answered 2026-07-13, ready for Phase 1 implementation
**Scope:** Receipt OCR App (`receipts.lumitra.co`)

## Context and motivation

This session manually built a Lola Stories vendor-spend pipeline from scratch: downloaded ~51 SaaS invoice PDFs (Anthropic, ElevenLabs, Google Workspace, Resend, Vercel, GitHub Actions) from a Google Drive folder, parsed them with `pdftotext` and regex, wrote the results into a Google Sheet, and hand-built a standalone HTML dashboard. That pipeline is fully manual: every new invoice means re-running the whole thing by hand, with no auto-update.

The Receipt OCR App (`/Users/marlinjai/software-dev/ERP-suite/projects/receipt-ocr-app`) already does almost exactly this job for paper/photo receipts: drag-drop upload, OCR, AI field extraction, dashboard, all auto-persisted in Cloudflare D1, no manual step. The ask: extend it so SaaS vendor invoice PDFs can just be dropped in like any other receipt, and the dashboard auto-reflects the total, replacing the manual sheet/dashboard entirely.

Three things the manual pipeline had to do by hand that the app doesn't do today:

1. **Multi-currency handling.** Several vendors bill in USD (ElevenLabs, Resend, Vercel, GitHub Actions); the app currently assumes a single implicit currency (EUR) for `Gross`/`Net`.
2. **Historical FX conversion.** USD invoices need to be converted to EUR at the ECB reference rate on their own invoice date, not a blanket rate, for the totals to be accurate. Done today via `api.frankfurter.dev` (free, keyless, ECB-sourced); see the worked example in this session's history for the exact rate lookups used.
3. **Shared/partial-business-use attribution.** The Anthropic Max plan subscription is shared across multiple projects and used by a co-founder on his own machine: only about 30% of it is actually Lola Stories cost. This is conceptually the same as the German "gemischte Nutzung" (mixed business/private use) split that freelancers already apply to phone bills etc., a percentage, not a binary category.

## Current state (for full detail, see `docs/public/architecture.md`)

- Next.js 16 on Cloudflare Workers, Google Cloud Vision OCR, OpenRouter for AI classification, `@marlinjai/data-table-adapter-d1` for persistence.
- **The D1 schema is fully dynamic** (`dt_tables` / `dt_columns` / `dt_rows` with cells as JSON), so adding new fields is a matter of adding `dt_columns` rows via the adapter, not a SQL migration. This makes everything proposed below additive, not a schema rewrite.
- Existing fields: `Name`, `Vendor`, `Gross`, `Net`, `Tax Rate`, `Date`, `Category` (SKR03), `Konto`, `Status`, `Confidence`, `Receipt Image`, `OCR Text`, `Zuordnung` (select: Universität / Geschäftlich / Privat).
- `Zuordnung` is the closest existing concept to "attribution" but it's a coarse 3-way category, not a percentage.
- The app is currently **single-workspace**. `WORKSPACE_ID` is a hardcoded constant in `src/lib/receipts-table.ts` and friends. The `workspace_id` column exists in the schema but nothing in the app currently switches it, so there's no multi-project isolation today (see Open Question 1).
- PDF handling already exists: the OCR route uses Vision's `files:annotate` for PDFs vs `images:annotate` for images (`src/app/api/ocr/route.ts`), so uploading these SaaS invoice PDFs directly should already work end-to-end without new plumbing, just possibly with lower field-extraction accuracy than a scanned paper receipt (worth verifying, since these are clean digital-text PDFs, which OCR usually handles very well or even trivially).

## Gap analysis

| Gap | Why it matters | Where it lives today |
|---|---|---|
| No `Currency` field | `Gross`/`Net` are bare numbers, implicitly EUR | New column needed |
| No FX conversion | Can't produce one true EUR total across mixed-currency vendors | New column(s) plus a data-flow step |
| No percentage-based attribution | `Zuordnung` is categorical, not a percent; can't express "30% Lola Stories" | New column needed, generalizes the Anthropic case |
| No project/client tagging | App is single-workspace; can't separate Lola Stories spend from Marlin's other client work | New column, or a real per-project workspace |
| No aggregate "Total" dashboard surface | 4 existing views (Table/By Konto/Board/Calendar) show rows, not a combined KPI total | New view or a stat-tile header |
| Vendor category matching (about 80 known vendors) doesn't know these SaaS vendors | `extract-receipt-fields.ts` category inference won't recognize "Anthropic", "ElevenLabs", etc. | Extend the vendor lookup table |

## Proposed data model additions

All additive `dt_columns` entries, no migration required:

| Column | Type | Notes |
|---|---|---|
| `Currency` | select (EUR, USD, GBP, ...) | Detected from OCR text ("$"/"USD" vs "€"/"EUR"), same regex approach used in this session's `pdftotext` parsing |
| `FX Rate` | number | Rate to EUR on the invoice's own `Date`, looked up from `api.frankfurter.dev` at save time. 1.0 for EUR rows |
| `EUR Equivalent` | number (computed) | `Gross` times `FX Rate` |
| `Business Share %` | number, 0 to 100, default 100 | Generalizes today's one-off "Anthropic = 30%" rule into a reusable field. Per-vendor default (see below) with per-invoice override |
| `Attributed EUR` | number (computed) | `EUR Equivalent` times `Business Share %` divided by 100. The number that should actually feed accounting/reporting totals |
| `Project` | select or multi-select | e.g. "Lola Stories", plus whatever else Marlin bills through this app. Simpler than standing up a second workspace, see Open Question 1 |

## Proposed automation logic

1. **Currency detection**: extend `extract-receipt-fields.ts`'s amount-extraction pass to also capture the currency symbol/code near the total. Fall back to EUR if ambiguous (matches current implicit behavior).
2. **FX lookup**: on save (or as a lazy background step), if `Currency` is not `EUR`, call `https://api.frankfurter.dev/v1/{date}?from={currency}&to=EUR` keyed by the extracted `Date`. Cache the rate (e.g. a small `fx_rates` table or a D1-backed cache keyed by currency and date) to avoid redundant calls across many invoices from the same day. Frankfurter/ECB doesn't publish weekend/holiday rates; it already falls back to the prior business day automatically, matching standard EU accounting practice (confirmed working in this session).
3. **Vendor-based default attribution percent**: a small editable lookup (vendor name to default `Business Share %`), so uploading a new Anthropic invoice auto-suggests 30% (Marlin can override per-invoice, and update the default over time; this rate will drift and needs periodic recomputation, it isn't a constant). Everything else defaults to 100%.
4. **Vendor category lookup**: extend the ~80-vendor lookup table in `extract-receipt-fields.ts` with the SaaS vendors from this session (Anthropic, ElevenLabs, Google Workspace, Resend, Vercel, GitHub Actions, ...) mapped to an appropriate SKR03 category (likely "Software & Lizenzen", Konto 4806, for all of them).

## New dashboard surface

- A stat-tile header (mirroring the hero KPI built in this session's standalone dashboard) showing **Total Attributed EUR**, filterable by `Project` and date range.
- Consider a 5th view: **Vendor Totals**, grouped by `Vendor`, summing `Attributed EUR`. The ranking-bar equivalent of what the standalone dashboard does today.

## Decisions (confirmed by Marlin, 2026-07-13)

1. **Project isolation: `Project` tag column**, not a real per-project workspace. Cheaper, reversible, one unified dashboard view; revisit a real workspace split only if data isolation between co-founders/clients actually becomes a requirement.
2. **Business Share %: per-vendor default with per-invoice override.** Vendor lookup auto-suggests a %, but any single invoice can be overridden if the actual share changes month to month.
3. **FX rate timing: both.** Live lookup via frankfurter.dev at OCR/save time by default, plus a manual "recompute FX for date range" batch action for invoices backfilled after the fact.
4. **Migration: run in parallel for now.** Do not retire the manual Google Sheet/standalone dashboard yet after Phase 4 backfill; keep both running as a sanity check until confidence is established.

## Suggested phasing

1. **Phase 1**: `Currency`, `FX Rate`, and `EUR Equivalent` columns, FX lookup via frankfurter.dev, vendor category-lookup extension for the known SaaS vendors.
2. **Phase 2**: `Business Share %` plus vendor-default config plus `Attributed EUR` computed column.
3. **Phase 3**: `Project` tagging plus a Totals/Vendor-Totals dashboard surface.
4. **Phase 4**: Backfill the 51 existing Lola Stories invoices, retire (or keep as a fallback) the manual sheet/dashboard pipeline.

This plan is intentionally not fully speced at the implementation-detail level (exact API route changes, exact `extract-receipt-fields.ts` diffs). That's for whichever session picks this up, once the open questions above are answered.
