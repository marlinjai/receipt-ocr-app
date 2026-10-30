---
title: One sidebar for the receipts app
summary: The dashboard's single row of eleven buttons mixed places, maintenance jobs and upload, and each page had its own way to reach the others. The wide layout gets one sidebar on every page; the maintenance jobs move to a "Werkzeuge" page; labels become German.
type: plan
status: completed
tags: [navigation, layout, dashboard, ux]
projects: [receipt-ocr-app]
date: 2026-10-30
---

# One sidebar for the receipts app

Marlin found the dashboard's action row unintuitive on 2026-10-30 and chose the left sidebar over a
top app bar and a slim icon rail on a page with mockups of all three.

## Decided

- **Places and jobs are apart.** Überblick, Belege, Ausgaben, Finanzen, Bewirtung, Kontakte and
  Regeln are places. Import, exchange rates, line items and invoice numbers are jobs run now and
  then, and live on `/app/tools`. Page sections replace the popovers: the page is reachable from
  everywhere and also on a phone, where two of the jobs were missing.
- **Upload is the one primary action.** The assistant and the CSV export stay on the dashboard,
  because they act on what it shows.
- **The sidebar folds to icons,** by hand (kept in a cookie, so the first paint is right) and by
  itself under 1024 pixels, where the table needs the width. Its width alone decides what it
  shows, through a container query. Folded, the company select stays: narrow, it still opens the
  full list.
- **Counts sit on the places.** The dashboard reports what it already loaded; other pages ask once
  when they open, so a completed meal is counted on the way out. A failed answer keeps the last
  numbers: a count is help, not a condition.
- **The phone keeps its header and "Mehr" menu,** with the same places.

## Not changed

The filter bar's "Add filter" comes from `@marlinjai/data-table-react`, and stays English until
that package offers labels.
