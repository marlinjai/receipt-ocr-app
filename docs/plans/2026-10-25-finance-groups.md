---
title: Finanzen in four groups
summary: The eight tabs of the Finanzen page become four groups (Erledigen, Auswerten, Steuer, Einstellungen). The four tiles and the "Offen" checks stay the entry, there is no extra overview page, and Ausgaben stays its own page with a link each way.
type: plan
status: in-progress
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

## Reality (2026-10-26, branch feat/finance-groups)

Built as decided: a row of four groups (two to a row on a phone, every one a 44 pixel target) with
the tabs of the chosen group below; the four tiles and "Offen" stay the entry, no overview page.
The table of groups, tabs and addresses is `src/app/app/finance/tabs.ts`, tested on every value.

- **Where the payments went.** Erledigen, "Zahlungen klären": "Jetzt einordnen", "Wer ist das?",
  the estimates to accept, the payments without a receipt and the search. Auswerten, "Zahlungen":
  what the app classified, the transfers between own accounts, cancelled purchases, re-labelled
  payments, links and answers. Einstellungen, "Konten": accounts, bank connections, sharing, and
  the file import. `PaymentsTab` takes a `parts` prop; its sections stay where they were.
- **Addresses.** Every tab has its own `?reiter=` value (`offen`, `zahlungen-klaeren`, `euer`,
  `einnahmen`, `zahlungsliste`, `anlagen`, `umsatzsteuer`, `einkommensteuer`, `konten`,
  `lieferanten`, `eigene-namen`), a group name opens its first tab, the old `zahlungen` opens the
  payment questions. The page writes the open tab into the address, and the year change keeps
  it. The bank return now sends `reiter=konten`; `?bank=` alone lands on the accounts as well, so
  a return started before the deploy still lands right, with its message shown once.
- **Copy.** Texts that named "Zahlungen" or "Finanzen, Zahlungen" as a place (in Finanzen,
  Ausgaben and the check messages) name the new place.

Decided while building, say so if you disagree:

1. **The own names got a tab of their own under Einstellungen**, editing the same list as Ausgaben
   (the editor moved into `src/app/app/spending/OwnNames.tsx`, used by both pages; a change from
   Finanzen answers with the recomputed statement, since the payments read counts the names).
   Ausgaben keeps its editor.
2. **The file import sits with the accounts** under Einstellungen: it needs the account picker,
   and the bank connection, its alternative, is there too.
3. **Counts.** Erledigen carries the sum of what waits (open receipts, overdue invoices, open
   payments and unanswered counterparties, as the old tabs counted them); its two tabs keep their
   parts, which add up to it. The informational counts (invoices, assets, vendor rules) are gone:
   they were not work. The estimates to accept are not counted, as before (their payment can be an
   open payment already).
4. **Without an address** the page opens on the first work that waits ("Offen", then "Zahlungen
   klären"), else on the statement. "Offen" with nothing left offers "Zahlungen klären" when
   questions wait, and the payment tabs without any payment read in lead to the accounts.
5. **Tab names.** The questions are "Zahlungen klären" and the list "Zahlungen", so no two tabs
   share a name.

Still open: the phone and wide layout check in the browser on production data (build order step
3) happens after the deploy; locally the controls were checked in code (group buttons
`min-h-11`, tabs `max-sm:min-h-11`, buttons `ui-btn` at 44 pixels on a phone).

