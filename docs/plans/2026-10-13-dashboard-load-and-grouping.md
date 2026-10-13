---
title: The dashboard under 780 receipts: what loads, and recurring receipts in groups
summary: Measured on 2026-10-13, the receipts table needs 35 seconds to load all rows and holds 817 MB in the browser. Step one (built) leaves the recognized text out of the list, loads it per receipt and searches it on the server, and takes rows in pages of 200. Step two loads only the chosen years. Step three groups recurring receipts automatically.
type: plan
status: in-progress
tags: [receipts, dashboard, performance, groups]
projects: [receipt-ocr-app]
date: 2026-10-13
---

# The dashboard under 780 receipts

## Why

The owner noticed that the table is slow and said it needs optimization as the data grows, and
that the tax receipts want grouping. A year filter exists since 2026-10-12 (it narrows what is
shown; it does not narrow what is loaded).

## Measurement (production, 780 receipts, 2026-10-13)

| What | Value |
|---|---|
| Requests until the last row is there | 73, one after another (pages of 50 rows) |
| Time until the count stands still | 35 seconds (first rows after 2.4 seconds) |
| Data received | 3.1 MB decoded, 0.7 MB compressed (about 4 KB per row, most of it the recognized text) |
| Rows drawn in the browser | 500, with 77,565 page elements |
| Browser memory (JavaScript heap) | 817 MB |
| One cell edit in the grid | around 30 seconds end to end in a scripted run, some failed with the page closing |

The wait is round trips and the cost afterwards is the drawing: 500 rows of 29 columns.

## Step one (built, this pull request)

- **The recognized text stays out of the list.** `getRows`, `getRow` and the row an edit returns
  carry an empty cell for it (`src/lib/receipt-text.ts`). The detail panel asks for it when a
  receipt is opened (`getReceiptText`) and again after a new reading. The column is not drawn in
  the grid any more: it was a wall of text nobody read there.
- **A text search keeps working.** The list is searched in the browser as before (name, vendor,
  amounts); a term of three or more characters is also searched in the recognized text on the
  server (`searchReceiptText`, case-insensitive, percent and underscore taken literally, at most
  300 receipts), and a receipt is found when either finds it.
- **Pages of 200** instead of 50: four requests instead of sixteen for the same rows.

## Reviewed before merging

A fresh agent read the pull request on 2026-10-13. Fixed from its findings: the panel showed the
previous receipt's text while the next one loaded (the panel is now one per receipt); the AI
assistant lost the recognized text (its row tool takes `includeText` for up to 25 receipts and its
instructions say so); the search bar counted "0 results" for a hit found only in the text (the
list has its own search field with its own count, and it now searches live as rows arrive); a text
search cut at 300 receipts did not say so (it says so); the hits of the previous term vanished
while the next ones loaded (they stay); a duplicate text column would have kept its text in the
list (all such columns are emptied); a table not yet migrated made the search fail silently (it is
migrated first, as the list does).

## Step two (decided direction, not built)

Load only the years chosen. The year chips get their counts from one count query, the default is
the newest year with receipts, and the other years load when a chip is chosen. This is the real
fix: the table then holds a year (about 270 receipts now, never all), every sum in it is
complete for its year, and nothing needs "load more". Drawing only the visible rows (a virtual
list) is the second half and needs a change in the shared table package.

## Step three (open question to the owner)

Group recurring receipts automatically, so a subscription of twelve invoices is one row with its
sum, as in the owner's own expense table. Which key: vendor and item per year (recommended: it
matches how the returns summed their lines), or by form line. New receipts join an existing
group by the same key; a group is never a receipt and never counts itself.

## Open

- Step two and step three, after the owner's answers (default year; grouping key).
- Measure again after step one is deployed and write the numbers here.
