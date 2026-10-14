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

## Measured after step one (2026-10-14, deployed)

| | before | after |
|---|---|---|
| Until the count stands still | 35 s | 17 s |
| Data received (decoded) | 3.1 MB | 1.9 MB (0.19 MB compressed) |
| Browser memory | 817 MB | 169 MB |
| Elements on the page | 77,565 | 75,560 (the 500 drawn rows are still the cost) |

## Step two (built): the table loads the years it shows

Decided by the owner on 2026-10-14: the table opens on the newest year that has receipts.

- The year chips take their counts from one count query (`getYearCounts`, no row is loaded for
  it). The page opens on the year in the address (`?jahr=2024`, a range `2022-2024`, or `alle`),
  otherwise on the newest year. Choosing years fetches the list again for exactly those years.
- A list for years is one query per year on the start of the stored invoice date and comes in one
  answer, without the recognized text; groups that hold a receipt of those years come along.
  Receipts without a date come with "ohne Datum" or "Alle" (those load everything).
- A text search runs on the server over all years and says how many more receipts it found in
  years that are not loaded.
- Found while building it: the table package's own date comparisons ("after", "before") fail on
  this database because the parameter is text and the column is cast to a timestamp. The scope
  therefore does not use them. The filter bar's date operators are on the roadmap.

## Step three (built): recurring receipts in groups

Decided by the owner on 2026-10-14: per vendor and item per year, exactly.

- `src/lib/groups/auto.ts` is the rule: key is vendor, item and year of the invoice date, equal as
  written (case and spacing do not make two keys, no wording is guessed). Only receipts that count
  for tax (assignment business or university), not business meals, not receipts already in a
  group. A group is made from two receipts with one key, named "Vendor, Item, Year"; a receipt
  whose key has a group joins it.
- It runs each time the dashboard is opened, before the table loads, so the table arrives
  grouped. A failure leaves the table as it is.
- A person is not fought: a receipt put back at the top level (taken out of a group, or its group
  dissolved) is marked in a hidden column "Auto Group Off" and is never grouped automatically
  again.
- The sum of a group is the sum of its receipts that are loaded. In a year view a group made of
  one year is complete; a group a person made across years shows the part in the chosen years.

## Reviewed before the pull request (2026-10-14)

A fresh agent read the branch. Fixed from its findings: two page loads at once could make the
same group twice (runs are serialised per workspace in the process and an empty group that
carries the name of a populated one is removed); a link or a check naming a receipt of an older
year said it was gone (its year is looked up and added to the years shown); a quick second click
on a year chip could let the first answer win (an answer for a superseded choice is asked again
or dropped); a sorted list across years had the wrong order (a sorted list is not narrowed); the
chip counts went stale (they follow the rows); a long item cut the year off a group name (the item
gives way, the year stays); a key with more than 500 receipts failed on every load (it is moved in
parts); a failed group delete left its children marked (the mark goes again); the schema is now
brought up to date by the page itself before it groups; date years are read the same way on the
server and in the browser.

## Open

- A group a person renames is a different name for the rule: when two receipts of its key arrive
  later, a new group with the old name is made. No column tells the rule that a name was changed.
- A manual group whose name equals the name of a key takes receipts of that key in (joined by
  name, by design).
- The group delete dialog and the group panel count only loaded receipts: a group a person made
  across years under-reports in a year view. Automatic groups lie within one year.
- Two receipts that look alike (same day, vendor, total) are grouped like any other: the review
  list still shows them as a possible duplicate, now inside one group.
- The item is worded per receipt, so one subscription can split into several groups when its
  invoices word the item differently ("exactly" was the owner's rule). The roadmap line for one
  wording per subscription is the fix at the source.
