---
title: The receipts app on a phone
summary: Every page of the app fits a phone screen (360 and 390 pixels wide) without the page scrolling sideways. The receipts table becomes a card list on a phone (vendor, date, amount, category, status; a tap opens the existing detail panel), the dashboard's nine actions fold into a "Mehr" menu, tab rows scroll inside themselves, every control is a 44 pixel touch target, and the wide layout at 1280 stays as it was.
type: plan
status: decided
tags: [mobile, phone, layout, dashboard, finance, accessibility]
projects: [receipt-ocr-app]
date: 2026-10-24
---

# The receipts app on a phone

The owner opened the app on his phone on 2026-10-24 and found it needed a rework. This plan
records what was measured, what was decided, and what was built on the branch
`feat/mobile-rework`.

## What was measured (before)

Production at 390 by 844 pixels (headless, 2026-10-24), then the same pages on a local copy of
the branch's starting point (`origin/main` at 4730673) with 24 invented receipts. "Page width" is
`document.documentElement.scrollWidth`; the headless browser draws an 11 pixel scroll bar, so a
page that fits reads 379 at a 390 window and 349 at 360.

| Page | Page width at 390 | What was wrong |
|---|---|---|
| Dashboard (`/app/dashboard`) | 1101 on production, 1093 locally | The row of nine action buttons next to the heading ran three screens wide and dragged the whole page sideways. The view tabs (Table, By Konto, By Vendor, Board, Calendar) were cut off. The receipts showed as the desktop table, grouped by category, in a sideways-scrolling box. |
| Finanzen, tab "Offen" (`/app/finance`) | 379 empty, 460 with receipts | With open receipts, the list of open receipts sat in a grid column sized to its longest line and pushed the page 70 pixels wide. The five total cards stacked one per row and filled a whole screen. |
| Finanzen, other tabs | 379 | The tab row (up to nine tabs) scrolled but showed a scroll bar and did not bring the open tab into view. Tables with six columns (VAT periods, depreciation schedule, monthly reconciliation of a card account) had no sideways scroll of their own. |
| Übersicht (`/app/overview`) | 379 (368 at 360) | At 360 the vendor attribution rows overflowed. Two monthly charts stood side by side at 170 pixels each. 24 controls under 44 pixels (period chips at 26). |
| Bewirtung, Kontakte, Regeln, Upload, Import | 379 | Fit, but tabs at 42 pixels, header links at 16, small buttons and fields at 30 to 40. |
| App header (every page) | | "Ausgaben" and "Sign out" were 16 pixels tall. |

## Decisions

All decided by the coordinating session on 2026-10-24, say so if you disagree.

1. **The receipts table on a phone is a card list inside this app, not a fork of the data-table
   package.** Below Tailwind's `sm` breakpoint (640 pixels) the Table views draw
   `ReceiptPhoneList`: one card per receipt with vendor (or name), date, gross amount in its own
   currency, category and status; a tap opens the existing `ReceiptDetailPanel`. It takes
   exactly the rows the page shows, so the year chips, the search (names, vendors and the read
   text) and the filters narrow it the same way they narrow the table, and the year choice in
   the address (`?jahre=`) restores it after a reload. A group is one card with the sum of its
   receipts in euros, never its own amount; its receipts are in the group panel a tap opens, not
   repeated in the list. The list is sorted newest first, undated last, because on a phone the
   person is looking for what just happened; the table's own sort stays on the wide layout.
   Why not the package: the table is built for a mouse (column resizing, cell editing,
   keyboard navigation, checkbox selection), and a card list is a different component, not a
   narrower table. The switch happens in JavaScript (`usePhone`, a `matchMedia` subscription
   on the same 640 pixel boundary) because only one of the two may be mounted: the table keeps
   keyboard focus and selection state. Until the width is known (on the server and during
   hydration) neither is drawn, so a phone never mounts the table only to swap it out; the rows
   load in the browser anyway. Everything else that differs (the heading row, the view picker
   against the tab row, the bulk tools) switches by CSS, so the wide layout paints as before. While a reload is still running the list says the receipts are
   loading, and when loading failed it draws nothing under the page's error banner, never "no
   receipts". A group card counts and sums the receipts the choice above shows, like the wide
   table, and says "1 von 2 Belegen" when a search or filter hides some of its loaded receipts.
   Receipts of years that are not chosen are not loaded at all (the server sends only the
   chosen years), so they are not counted there, exactly as in the wide table.
2. **Selecting, bulk editing and making groups stay on the wide layout.** The card list has
   no selection, so "Set field", "Neue Gruppe" and the delete-selected button are hidden on a
   phone rather than shown doing nothing, and the Delete key does nothing there (a selection made
   on a wider window must not be deleted unseen). A receipt is still edited, re-read or deleted from its
   detail panel, and a group is still opened, emptied or dissolved from its panel.
3. **The view tabs on a phone are a plain picker ("Ansicht").** The package's `ViewSwitcher`
   carries rename, delete and add menus that open as popovers below each tab; inside a
   sideways-scrolling strip those would be clipped. On a phone (by CSS, below `sm`) a native select switches
   between the existing views; creating, renaming and deleting views stays on the wide layout.
   The Board and Calendar views keep the package's components and scroll sideways inside
   their own box, never the page. No package change is needed for this, so none is filed.
4. **The dashboard's nine actions fold into "Mehr".** On a phone the heading row holds the
   title, "+ Hochladen" (the primary action) and "Mehr", which opens a two-column menu in the
   page's flow (no popover to position or clip) with the same destinations as the wide row:
   Overview, Finanzen, Bewirtung (with its open count), Kontakte, Export CSV, Import, AI,
   Recompute FX. The wide row is unchanged and hidden below 640 pixels. The icons of both moved
   to one shared file; the destinations are written in both places (the wide row's styling is
   kept exactly as it was), and a test checks the menu's list of destinations.
5. **Every page follows the same phone rules**, at 360 and 390 pixels:
   - no sideways page scroll (`scrollWidth` equals the window width minus the scroll bar);
   - a tab row scrolls inside itself. The finance row (up to nine tabs, the only one wider than a
     phone) hides its scroll bar on a phone and brings the open tab into view (`useTabInView`,
     which only ever scrolls the row sideways, never the page). The meals and contacts rows have
     two and three tabs, fit at 360, and need neither;
   - every button, link that stands alone, field, picker and segmented choice is at least 44
     pixels tall. Shared classes (`ui-btn`, `ui-input`, `ui-seg`) get this from one rule in
     `globals.css`; pages full of small text controls (overview, rules, import) opt in with the
     `ui-touch` class (a label around a checkbox stays inline); single elements use
     `max-sm:min-h-11`. Links inside running text are
     left as they are (they are exempt, and a 44 pixel line height would tear the paragraph);
   - text fields use 16 pixel type on a phone, because Safari on the iPhone zooms the page in on
     focus below that and leaves it zoomed;
   - amounts are right-aligned with tabular figures, forms are one column (they already were);
   - the five total cards of the finance page stand two to a row with the result across both.
6. **The wide layout stays as it was at 1280 pixels.** Phone changes are behind `max-sm:`, the
   639 pixel media query or `usePhone`, with three deliberate exceptions that change nothing at
   1280: the finance total cards stand two to a row with the result across both up to 1023
   pixels (tablets gain the same arrangement), and `min-w-0` on an overview attribution field and
   a `max-w-[calc(100vw-2rem)]` cap on the Recompute FX panel apply at every width (both only
   take effect on a narrow screen). Measured: the dashboard at 1280 differs from before only by
   sub-pixel text rendering and the development build's "Rendering" badge.
7. **Motion**: the menu opens with the existing 180 millisecond ease-out panel entrance, the
   menu arrow turns in 150 milliseconds; nothing eases in, both stop under reduced motion.

## Boundaries kept

Other branches are rebuilding parts of the app at the same time, so these were not touched:
the spending page (`src/app/app/spending/*`, rebuilt by `feat/budget-overview` with its own
phone requirement; it already fits at 360 and gains the shared 44 pixel fields and buttons from
`globals.css`), `src/lib/spending/*`, `src/lib/tax/service.ts`, `YearBoundaryTab.tsx`,
`IncomeTaxTab.tsx` (its two tables have two columns and fit) and `src/lib/tax/payments/*`. The
changes in the other finance tabs are layout only: a sideways scroll box around the VAT periods
table, the depreciation schedule and the monthly reconciliation of a card account (only the
table scrolls, not its summary line).

## Built

- `src/app/app/dashboard/ReceiptPhoneList.tsx`: the card list, with its date and amount
  formatting.
- `src/app/app/dashboard/DashboardPhoneActions.tsx` and `dashboard-icons.tsx`: the phone
  heading row and menu, and the icons shared with the wide row.
- `src/lib/use-phone.ts` (`usePhone`) and `src/lib/use-tab-in-view.ts` (`useTabInView`).
- `DashboardClient.tsx`: the phone heading, the picker for views, the card list in place of the
  table on a phone, the page scrolling down the list instead of a box inside a box.
- `globals.css`: the phone card, the 44 pixel rules, 16 pixel fields, `ui-touch`.
- Finance: two-to-a-row total cards, the open receipts list in a `grid-cols-1` column so its
  long lines truncate instead of widening the page, tabs at 44 pixels kept in view, three tables
  in sideways scroll boxes (the summary of the monthly reconciliation stays put).
- Overview: charts one per row on a phone, attribution rows that shrink, `ui-touch`.
- The AI assistant panel is `min(420px, 100vw)` wide, so it no longer runs off a phone's left
  edge, and as tall as the visible screen (`100dvh`), so the iPhone toolbar does not cover its
  input.
- Header, meals, contacts, rules, upload and import: 44 pixel links, tabs and controls.

## Verified

Locally against the branch with a throwaway database and the development login, through the
headless automation browser, at 360, 390 and 1280 pixels for the dashboard, upload, import,
meals, contacts, overview, rules, spending and all eight finance tabs; screenshots before and
after are kept under the dev-browser temporary folder (`mobile-rework/before` and
`mobile-rework/after`). On the phone dashboard the menu, the detail panel, the Board and
Calendar views, a search with hits and one without, and the AI panel were opened, each with no
sideways page scroll. Tests: `DashboardClient.phone.test.tsx` runs the whole dashboard at phone width
with the real table package and a fake data source: cards and the view picker in place of the
table, a card opening the detail panel, opening on the years a link names, the search narrowing the
cards down to none and back, a failed load not shown as an empty list, and the wide layout
keeping its table and tab row. The year test hands the years over as the page does (it reads
`?jahre=` on the server and passes it as `initialYears`). `ReceiptPhoneList.test.tsx` covers the list itself (order, groups, the empty,
narrowed, loading and failed states, formatting), `DashboardPhoneActions.test.tsx` the menu,
and `src/lib/__tests__/phone-layout-hooks.test.tsx` the two hooks.

## Follow-up after the first deployment (2026-10-24)

The coordinating session measured production with real data at 360 and 390 after the deploy
(5639f77). Everything fit except two places the local data of the first round could not show:

| Page | Production at 390 | Cause | Fix |
|---|---|---|---|
| Übersicht (`/app/overview`) | 1403 | The monthly chart per currency (two years of months in EUR, USD and GBP) sat in a grid column sized to its content, every month a column, 1366 pixels wide. | Each currency's chart scrolls sideways in its own box (`ScrollBox`: a named region and a tab stop only while it scrolls), every month keeps a 28 pixel column with the year under the first month and every January, and the box opens on the newest months before the first paint and stays at its end when a turned phone changes its width, unless the person scrolled back. The chart grid has bounded columns (`grid-cols-1`, `minmax(0, 1fr)`). This also fixes the wide layout, where two years of months had been squeezed past the edge of their half of the screen. |
| Finanzen, tab Einkommensteuer | 445 | The tables "Steuern" (367 pixels) and "Lohnangaben" (412 pixels) had no sideways scroll of their own. | Both sit in a `ScrollBox` with the `ui-table-scroll` style: a named region reachable with the keyboard while it scrolls, with room on the right for the focus ring of a button at its edge; on a phone the first column stays put (9rem wide, a long employer name wraps) while the figures scroll, and an amount stays on one line. The change in `IncomeTaxTab.tsx` is one import and the two wrapper lines per table, not reindented, because `feat/year-boundary-auto` changes the same file. |

Verified locally with production-like data: 143 receipts in EUR, USD and GBP from January 2024
to October 2026 and nine wage statements with a long employer name. Before the fix the overview
measured 699 and the income tax tab 466 at 390; after it, both fit at 360 and 390, and at 1280
nothing widens the page. Tests: `ScrollBox.test.tsx` (a region and tab stop only while it scrolls,
opening on its end, staying at its end through a change of width, staying where the person
scrolled it, opening on its end again for new content, cleanup), `OverviewClient.test.tsx` (many
months in three currencies, each in its own box as wide as its months need, grid columns that may
shrink, the year labels, few months) and `IncomeTaxTab.scroll.test.tsx` (both tables in a named,
focusable scroll box; a file of its own so the tab's main test file, which the other branch
changes, is not touched). The sticky column and
the one-line amounts are CSS, checked in the browser at 360 and 390, not in jsdom.

## Left open

- The finance tabs were measured with receipts but without payments, invoices, assets or VAT
  periods in the local database; the three wide tables there are contained by construction
  (sideways scroll boxes), not by a measurement with rows. Checking them on production with
  real data on a phone is the roadmap line's last step.
