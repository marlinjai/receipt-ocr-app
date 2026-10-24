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
   keyboard focus and selection state.
2. **Selecting, bulk editing and making groups stay on the wide layout.** The card list has
   no selection, so "Set field", "Neue Gruppe" and the delete-selected button are hidden on a
   phone rather than shown doing nothing. A receipt is still edited, re-read or deleted from its
   detail panel, and a group is still opened, emptied or dissolved from its panel.
3. **The view tabs on a phone are a plain picker ("Ansicht").** The package's `ViewSwitcher`
   carries rename, delete and add menus that open as popovers below each tab; inside a
   sideways-scrolling strip those would be clipped. On a phone a native select switches
   between the existing views; creating, renaming and deleting views stays on the wide layout.
   The Board and Calendar views keep the package's components and scroll sideways inside
   their own box, never the page. No package change is needed for this, so none is filed.
4. **The dashboard's nine actions fold into "Mehr".** On a phone the heading row holds the
   title, "+ Hochladen" (the primary action) and "Mehr", which opens a two-column menu in the
   page's flow (no popover to position or clip) with the same destinations as the wide row:
   Overview, Finanzen, Bewirtung (with its open count), Kontakte, Export CSV, Import, AI,
   Recompute FX. The wide row is unchanged and hidden below 640 pixels. The icons of both moved
   to one shared file so they cannot drift apart.
5. **Every page follows the same phone rules**, at 360 and 390 pixels:
   - no sideways page scroll (`scrollWidth` equals the window width minus the scroll bar);
   - a tab row scrolls inside itself, its scroll bar hidden like the contacts page already
     did, and the open tab is brought into view (`useTabInView`, which only ever scrolls the row
     sideways, never the page);
   - every button, link that stands alone, field, picker and segmented choice is at least 44
     pixels tall. Shared classes (`ui-btn`, `ui-input`, `ui-seg`) get this from one rule in
     `globals.css`; pages full of small text controls (overview, rules, import) opt in with the
     `ui-touch` class; single elements use `max-sm:min-h-11`. Links inside running text are
     left as they are (they are exempt, and a 44 pixel line height would tear the paragraph);
   - text fields use 16 pixel type on a phone, because Safari on the iPhone zooms the page in on
     focus below that and leaves it zoomed;
   - amounts are right-aligned with tabular figures, forms are one column (they already were);
   - the five total cards of the finance page stand two to a row with the result across both.
6. **The wide layout stays as it was at 1280 pixels.** Every phone change is behind
   `max-sm:` or the 639 pixel media query, or replaces a value only below `sm`. Measured: the
   dashboard at 1280 differs from before only by sub-pixel text rendering and the development
   build's "Rendering" badge.
7. **Motion**: the menu opens with the existing 180 millisecond ease-out panel entrance, the
   menu arrow turns in 150 milliseconds; nothing eases in, everything respects reduced motion.

## Boundaries kept

Other branches are rebuilding parts of the app at the same time, so these were not touched:
the spending page (`src/app/app/spending/*`, rebuilt by `feat/budget-overview` with its own
phone requirement; it already fits at 360 and gains the shared 44 pixel fields and buttons from
`globals.css`), `src/lib/spending/*`, `src/lib/tax/service.ts`, `YearBoundaryTab.tsx`,
`IncomeTaxTab.tsx` (its two tables have two columns and fit) and `src/lib/tax/payments/*`. The
changes in the other finance tabs are layout only: a sideways scroll box around the VAT periods
table and the depreciation schedule, and `overflow-x-auto` on the monthly reconciliation of a
card account.

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
  in sideways scroll boxes.
- Overview: charts one per row on a phone, attribution rows that shrink, `ui-touch`.
- The AI assistant panel is `min(420px, 100vw)` wide, so it no longer runs off a phone's left
  edge.
- Header, meals, contacts, rules, upload and import: 44 pixel links, tabs and controls.

## Verified

Locally against the branch with a throwaway database and the development login, through the
headless automation browser, at 360, 390 and 1280 pixels for the dashboard, upload, import,
meals, contacts, overview, rules, spending and all eight finance tabs; screenshots before and
after are kept under the dev-browser temporary folder (`mobile-rework/before` and
`mobile-rework/after`). On the phone dashboard the menu, the detail panel, the Board and
Calendar views, a search with hits and one without, and the AI panel were opened, each with no
sideways page scroll. Tests: `ReceiptPhoneList.test.tsx` (forward, a filter change, resuming
from the year in the address, the empty, narrowed and loading states, formatting),
`DashboardPhoneActions.test.tsx` and `src/lib/__tests__/phone-layout-hooks.test.tsx`.

## Left open

- The finance tabs were measured with receipts but without payments, invoices, assets or VAT
  periods in the local database; the three wide tables there are contained by construction
  (sideways scroll boxes), not by a measurement with rows. Checking them on production with
  real data on a phone is the roadmap line's last step.
