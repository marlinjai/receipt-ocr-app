---
title: What was bought, in the receipt's name
summary: A receipt gets a cell "Item" with what was bought in a few words, read by the model, and its name becomes vendor, item, total, date. The name now follows its cells when one of them is corrected. Receipts stored before get their item from their stored text, without being read again.
type: plan
status: in-progress
tags: [receipts, reader, naming, dashboard]
projects: [receipt-ocr-app]
date: 2026-10-11
---

# What was bought, in the receipt's name

## Why

Since 2026-10-11 a receipt is named "vendor, total, date". That is exact and it is empty where
the vendor is a marketplace or a billing platform: "Amazon, 106,24 €, 18.07.2024" does not say
that it is a drive enclosure, "Patreon, 3,57 €" not which subscription, and one vendor sells
several things. The first idea, putting the legal entity or the product into the vendor cell,
breaks the grouping by vendor and the decisions per vendor in the finance area. The owner
decided on 2026-10-11: one rule for every receipt of every year, the item as its own part of
the name.

## What is built

- **A column "Item"** (text) on the receipts table: what was bought, in a few words. It is
  created on every existing table by the next page load, like any other column.
- **The reader gives it.** The model is asked for the item (two to four words, in German, a
  product or plan by its own name, otherwise the kind of thing; with several line items the main
  one and how many more follow). It is no longer asked for a name, which was never used. The
  item is cut to 48 characters and loses commas. It is not checked against the recognized text
  the way amounts and dates are: it states no fact the books use.
- **The name** is "vendor, item, total, date", still built by the app from the cells and never
  written by a model. An item that only repeats the vendor is left out. A business meal has no
  item: it is named by its restaurant, and what was eaten belongs to the meal register.
- **The name follows its cells.** A write that changes vendor, item, total, currency or date
  builds the name again, when the stored name is one that was built (it ends in a total or a
  day, or it stands for an unreadable file). A name a person typed stays, and so does the name
  of a group. The table shows the new name at once, because the edit returns the row.
- **A new reading of a stored receipt** fills the item only where it is empty, and builds the
  name from the row as it is after the write, so a vendor that was kept is the one in the name.
- **Stored receipts** get their item through `POST /api/receipts/items` with a list of row ids
  (at most 25 per call): the item is read from the stored text by the small model, only where
  the row holds none, and the name is built again from the row's own cells. Vendor, total, date
  and every decision stay untouched, because people have corrected them since. A row that could
  not be asked is unchanged and can be sent again. The caller names the rows, so a part of the
  table somebody is working on can be left out.

## Decisions

1. One rule for all receipts, not a list of marketplaces (owner, 2026-10-11).
2. The item is written in German, product names as they are: the app's lists and the export
   text are German. Decided here; a different language is a change of one sentence in the prompt.
3. No item on business meals (see above).
4. The fill of stored receipts is not a new reading: a new reading rewrites vendor and total and
   would undo corrections made by hand.
5. The fill is run by row ids from outside, year by year. The business meals of 2025 are left
   out while the owner is completing the meal register.

## Open

- Deploy, then fill every receipt of every year under both companies and check the names on
  production.
