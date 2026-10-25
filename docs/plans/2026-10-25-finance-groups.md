---
title: Finanzen in four groups
summary: The eight tabs of the Finanzen page become four groups (Erledigen, Auswerten, Steuer, Einstellungen). The four tiles and the "Offen" checks stay the entry, there is no extra overview page, and Ausgaben stays its own page with a link each way.
type: plan
status: decided
tags: [receipts, finance, navigation, ui]
projects: [receipt-ocr-app]
date: 2026-10-25
---

# Finanzen in four groups

## Why

Finanzen shows eight tabs in one row: Offen, EÜR (Einnahmenüberschussrechnung, the income-surplus
statement), Einnahmen, Zahlungen, Anlagen, Umsatzsteuer, Einkommensteuer, Lieferanten. Things to
do, things to read, tax forms and settings are mixed, and on a phone the row scrolls sideways.
The coordinating session proposed four groups on 2026-10-25 after the Jahreswechsel tab was
removed.

## Decisions (the owner, 2026-10-25)

1. **Four groups; the tiles and "Offen" stay the entry, no extra overview page.** The four tiles
   at the top already are the overview.
2. **Ausgaben stays its own page, with a link each way.** Ausgaben is the budget view of all money,
   private included; Finanzen is the business view for the tax return.

## Decisions (taken by the coordinating session on 2026-10-25, say so if you disagree)

3. **What goes where.**
   - **Erledigen**: Offen (the checks, overdue invoices), and from Zahlungen the questions
     ("Wer ist das?", receipts to confirm, estimates to accept).
   - **Auswerten**: EÜR, Einnahmen, Anlagen, and from Zahlungen the list of payments and the
     counterparties the app classified.
   - **Steuer**: Umsatzsteuer, Einkommensteuer (with the filing day of the year).
   - **Einstellungen**: Lieferanten, own names, accounts and bank connections, sharing private
     payments with another company.
   Zahlungen therefore splits into its questions (Erledigen) and its list (Auswerten); the
   accounts move to Einstellungen.
4. **Two levels, still one page.** A group row on top, the existing tabs of the chosen group
   below; the address keeps the choice (`?reiter=`, existing values such as `zahlungen` keep
   working and open the matching group), so links from notifications and the bank return still
   land in the right place. Counts move up to the group (the sum of what waits in it).
5. **Links.** Finanzen gets a link "Ausgaben" next to the tiles, Ausgaben keeps its link to
   Finanzen, the header link stays.

## Build order

1. The group model and the address mapping, tests on every old `?reiter=` value.
2. Splitting Zahlungen into questions and list, the accounts into Einstellungen.
3. Phone and wide layout checked in the browser on production data (every control a 44 pixel
   touch target, as in plan 2026-10-24-phone-layout).
4. Fresh-agent review, pull request, land-pr.

## Tests (four paths, standard `stateful-flow-testing.md`)

- Forward: each group shows its tabs; counts add up to the open work.
- Backtrack: switching groups and back keeps the tab chosen inside each group.
- Resume: a reload with `?reiter=` opens the same group and tab; old values still work.
- Re-entry: the bank return (`?bank=`) lands in Einstellungen with its message shown once.
