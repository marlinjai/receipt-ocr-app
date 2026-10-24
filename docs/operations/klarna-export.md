---
title: Klarna purchases from the Klarna web app
summary: How the Klarna purchase list is exported from the signed-in Klarna web app (Klarna offers no table export), turned into the importer's file, and imported under Finanzen, Zahlungen, with the run of 2026-10-23 as the worked example.
type: documentation
tags: [operations, klarna, payments, import]
projects: [receipt-ocr-app]
date: 2026-10-23
---

# Klarna purchases from the Klarna web app

The payments tab needs Klarna's own list of purchases to pair Klarna's collective debits on the bank
account with the purchases behind them (the funding rule, `src/lib/tax/payments/funding.ts`). Klarna
offers no table export. Two scripts in `scripts/klarna/` read the list from the Klarna web app and turn
it into the file the importer reads as `klarna_csv`.

## What the scripts do

- **`klarna-web-export.js`** runs in the dev-browser sandbox against the visible automation Chrome,
  where the Klarna login lives. It opens `app.klarna.com/manage-payments`, takes the sign-in token the
  page itself sends (the token stays inside the page and is never printed), lists every purchase the
  app knows (completed and open payments) and reads each one's day, time, amount, merchant, payment
  reference and order reference into `klarna-raw.json` in the dev-browser temp folder
  (`~/.dev-browser/tmp/`).
- **`klarna-to-csv.py`** turns `klarna-raw.json` into the importer's file and keeps only purchases
  whose payment reference or order reference is in none of the files imported before. A purchase the
  shop has not charged yet (reserved) is written with the status "In Bearbeitung", which the importer
  skips until a later export shows it charged.

## Running it

1. Sign in to Klarna in the visible automation Chrome, if the session has run out. Start a new
   export by deleting `~/.dev-browser/tmp/klarna-raw.json`: otherwise the list of purchases of the
   last export is used and a new purchase is never found.
2. Read the purchases. The app's token lasts only a few dozen requests, so each run reads at most 35
   purchases; run it again until it prints `left 0`:

   ```bash
   dev-browser-auto --visible --timeout 170 run scripts/klarna/klarna-web-export.js
   ```

   Each run prints `purchases <n> read <n> reserved <n> failed this run <n> left <n>`. A purchase
   that failed is read again by the next run, and so is a reserved one (not charged yet), so its
   status is current when the export ends.
3. Convert, naming every Klarna file imported before, so only new purchases are written:

   ```bash
   python3 -I scripts/klarna/klarna-to-csv.py ~/.dev-browser/tmp/klarna-raw.json klarna-new.csv <earlier-export-1.csv> [<earlier-export-2.csv> ...]
   ```

   It stops with a message when an amount is not in euros (another currency), rather than writing a
   wrong amount. A row of an earlier file with the status "In Bearbeitung" counts as not imported
   (the importer skipped it), so a reserved purchase is written again once it is charged.
4. Import `klarna-new.csv` under Finanzen, Zahlungen, on the Klarna account.

## The run of 2026-10-23

- 269 purchases read from the web app; 56 of them new since the last export (which ended on
  30.09.2026).
- 50 imported on production (company Whiz-Art Media, Klarna account); 6 reserved on 23.10 were
  skipped as "In Bearbeitung" and come with the last export.
- Every Klarna collection on the bank account (a bundle of purchases) matched its purchases to the
  cent, including the one of 1,261.69 EUR on 23.10.2026 (62 purchases, 24.09 to 22.10).
- The reconciliation in the payments tab then still showed 977.08 EUR more collected than listed for
  2026. A read-only look at production showed why: Klarna's list holds instalment purchases (about
  4,800 EUR listed in November 2025), which the bank collects over the following months. The
  reconciliation compared each year on its own, so 2,721.83 EUR listed in earlier years and collected
  in 2026 looked like a gap. It now carries what earlier years left open into the year, and allows a
  pay-later service to be behind by the purchases of the last 60 days of its list (not due yet). With
  that, 2026 reconciles: the running balance closes to 15 cents at the end of August 2026, and what is
  open after it is September and October purchases Klarna collects later.

## Klarna ends

The owner stops using Klarna pay-later from 2026-10-23: no new purchases after 23.10.2026. Klarna
still collects the open payments (802.42 EUR, due in about 19 to 23 days from 23.10) and the 6
reserved purchases. One last export once every open Klarna payment is collected closes the list; after
that, a Klarna debit without purchases in the list is a question again. The open step is on
`ROADMAP.md`.
