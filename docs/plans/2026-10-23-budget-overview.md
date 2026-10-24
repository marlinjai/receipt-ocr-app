---
title: A visual budget overview that shows real spending
summary: The spending page becomes a picture first (months by category, budget against spent, the biggest counterparties) and a work list second, and the numbers under it are cleaned so the picture is true. Transfers to the owner's own name count as own transfers without a question, and a Klarna collective debit whose purchases are not imported yet waits for its list instead of counting as one big unknown expense.
type: plan
status: in-progress
tags: [receipts, spending, budgets, overview, payments]
projects: [receipt-ocr-app]
date: 2026-10-23
---

# A visual budget overview that shows real spending

## Why

The owner, 2026-10-23: "there's still not really an easy way to overview all payments in a visual
way to do my budgeting." What production showed that day (company Whiz-Art Media, year 2026):

- Ausgaben 2026: 83,486.39 EUR, of which 82,115.23 EUR "Nicht zugeordnet" (no private or business
  answer yet).
- Category "Unklar": 679 payments, 63,375.59 EUR. The largest single counterparty in it is the
  owner himself ("Marlin Jai Pohl", three spellings, 67 payments, 42,553.91 EUR): transfers to his
  own spaces and accounts ("Main Account - Rainy Day Fund"), which are no spending at all.
- "Klarna Bank AB (publ), Klarna Sammelzahlung, 1,261.69 EUR" on 23.10.2026 counts as one
  unclear expense and raises "Beleg fehlt", because the Klarna list is imported only up to
  28.09.2026, so the funding rule (`src/lib/tax/payments/funding.ts`, which recognises a bank
  debit to Klarna or PayPal as the money behind purchases already listed) does not cover it.
- The page opens with "Belege prüfen (2596 offen)" and two dozen notifications, many of them for
  exactly these own transfers. The month bars and the budgets exist, but sit below that list and
  are dominated by the grey "Unklar" share.

So the picture is wrong before it is ugly. Both are fixed here.

## Decisions (decided by the coordinating session on 2026-10-23, say so if you disagree)

1. **Own name means own account.** Each company keeps a short list of the owner's own names
   (`SpendingSettings`, new column `own_names`, text array). It starts with the signed-in owner's
   name as the auth service knows it, and can be edited on the spending page ("Eigene Namen").
   A counterparty whose normalised name equals one of them (case, accents, word order and
   punctuation ignored) is treated as `own_account`: not spending, no receipt asked, no
   notification. Derived on read, nothing is written to the payments. An explicit counterparty
   answer given in the payments tab still wins. Open "Beleg fehlt" notifications for such
   payments are closed by the next loop run with the reason "eigenes Konto".
   Why a list and not one answer: the bank spells the name three ways, and the private company
   (marlinjai) sees the same name again once accounts are shared.
2. **A pay-later debit beyond its list waits for the list.** A bank debit to a held pay-later
   service (Klarna) after the end of that service's imported list is "Sammelzahlung, Liste
   folgt": not spending, no receipt asked, and the overview names it ("1 Klarna-Sammelzahlung
   über 1.261,69 EUR wartet auf die nächste Klarna-Liste"). When the list arrives, the existing
   rule pairs it as today. Same for PayPal (a wallet) only where its list stops and no live
   connection continues it. This touches `funding.ts`, which the PayPal live build
   (branch `feat/paypal-live`) also changes, so this step is built last, on a main that already
   holds the PayPal pull request.
3. **Picture first, work list second.** The spending page gets two tabs: "Überblick" (default)
   and "Belege" (the receipt checks and the notifications, with the open count on the tab). The
   overview, top to bottom:
   - the four totals as today, with own transfers and waiting collective debits named under them;
   - **months by category**: twelve stacked bars, one colour per category, a line for the sum of
     the monthly budgets, a click on a month filters everything below to that month (as today);
   - **budget against spent** for the period: one horizontal bar per category with its limit
     marked, over-budget in the warning colour, the projected month end as a faint extension;
   - **biggest counterparties** of the period (top ten, with category and share);
   - the "Unklar" list to answer, as today.
   Every chart has a text equivalent (an accessible table or labelled list), works on a phone
   (bars scroll sideways inside their panel, never the page), and in light and dark.
4. **No chart library.** Plain SVG and CSS in the existing components, colours from the dataviz
   palette method, so the bundle does not grow and the charts match the app's tokens.
5. **Where it is checked.** In Whiz-Art Media now, and in marlinjai once the owner has shared the
   four accounts (plan 2026-10-22, payments across companies). Nothing here depends on the share.
6. **Klarna ends (owner, 2026-10-23):** no new purchases after 23.10.2026; one last export once every
   open Klarna payment is collected closes the list, after which a Klarna debit without purchases in
   the list is a question again. Decision 2 stays needed until then: 802.42 EUR are open (due in about
   19 to 23 days) and 6 purchases reserved on 23.10 will still be collected. How to export:
   `docs/operations/klarna-export.md`.

## Tests (four paths, standard `stateful-flow-testing.md`)

- Forward: own-name payments leave "Unklar" and the totals; a late Klarna debit is named as
  waiting; the charts render the categories.
- Backtrack and revise: removing a name from "Eigene Namen" brings its payments back as unclear
  (and asked for again); an explicit counterparty answer overrides the name rule both ways;
  importing the Klarna list turns the waiting debit into the usual pairing.
- Resume: reload keeps the tab and the month filter (URL state), and the names (database).
- Re-entry: a second identical import or a second loop run changes nothing and sends nothing.

## Build order

1. Own names (migration, rule in the overview and in the missing-receipt loop, settings UI).
2. Tabs and the three charts.
3. Waiting collective debit (after the PayPal live pull request is merged).
4. Fresh-agent review, pull request, land-pr.

## Reality (2026-10-23, branch `feat/budget-overview`)

Built so far, with what the build decided on the way (say so if you disagree):

- **Own names (step 1).** Column `spending_settings.own_names` (migration `0037_spending_own_names`,
  additive, empty default). The rule lives in `src/lib/spending/own-names.ts` (words of the name
  normalized like a counterparty, then sorted, so case, accents, punctuation and word order do not
  matter; whole names only, "Erika" never matches "Erika Shop") and is applied in one place,
  `spendingTreatments` in `src/lib/spending/service.ts`, which the overview, the budgets and the
  missing-receipt loop all read. Only an answer of the payments tab overrides it; a category answer
  does not. *Decided:* the sign-in (auth-brain) gives the app no person's name, only the e-mail
  address, so the list starts empty and the page asks for the name up front in a highlighted card,
  rather than guessing a name from the e-mail address. Saving the names settles open "Beleg fehlt"
  messages at once (not only on the next loop run); a loop run that settles such messages says
  "erledigt: eigenes Konto". Counterparties made own accounts by a name show under "Eigene Konten"
  with "über Eigene Namen" and no take-back button (they change with the names).
- **Tabs and charts (step 2).** `?ansicht=belege` opens "Belege" (a notification link with
  `pruefen` opens it too); the default is "Überblick". Charts in plain HTML and CSS
  (`src/app/app/spending/OverviewCharts.tsx`, data in `src/lib/spending/charts.ts`). Colours: seven
  categories take the seven slots of the dataviz reference palette in its dark steps, validated as a
  set against the panel surface; the four smallest categories share "Weitere", "Unklar" is a hatched
  grey. *Decided:* the app is dark only (`globals.css` sets `color-scheme: dark`), so the charts carry
  dark values only. *Decided:* "budget against spent" compares the private part (as the budgets do)
  with the monthly limit once for a month, twelve times for a past year and once per month begun for
  the current year; the projection shows only for the current month. The budget line over the months
  is the sum of the monthly category limits, labelled as counting only the private part.
- **Waiting collective debit (step 3), built on main after the PayPal live pull request (#170):** a
  bank debit naming a held service after the last day of its list is a transfer marked
  `awaitingList` (`src/lib/tax/payments/funding.ts`): not spending, no receipt asked, named under the
  totals ("1 Klarna-Sammelzahlung über ... wartet auf die nächste Klarna-Liste") and in the payments
  tab's list of transfers. The next list covers its day and the usual rule pairs it; a person who says
  what the debit is overrules it. *Decided:* it waits at most 60 days after the list's last day (the
  longest pay-later term, `PAY_LATER_TERM_DAYS`), then it is a question again. That is also how
  "Klarna ends" closes without a new setting: after the last export, a later Klarna debit asks. A
  wallet waits only while no live connection continues its list (PayPal through the bank interface
  is never late).
- **Decided after the second review:** the waiting rule applies to pay-later services only (Klarna):
  a PayPal bank debit is the purchase itself and stays a question when the list does not show it. A
  Klarna debit after the end of the list first pays what the list still holds open (its purchases of
  the last 60 days, less what the bank collected since); only what goes beyond waits, so the final
  collections after the last export are ordinary collections, not waiting ones. The reconciliation
  leaves waiting debits out of "collected" and names them. The carry-over from earlier years is
  limited to their last 60 days of purchases (a purchase never collected stays a question in its own
  year), and a year whose last purchases the next year collects is no gap either. On the spending
  side the names now win over a "private" answer of the payments tab (a private withdrawal to the
  owner is still no spending); "business" or "mixed" there still wins. The per-category totals of all
  spending are back under the charts, the payments table says when a debit waits for its list, and
  the Klarna scripts read reserved purchases again until they are charged.
- **Decided after the first review:** own names are matched word for word without dropping legal
  forms, so "Erika Beispiel UG" (another legal person) is never the owner; and because answers are kept
  per counterparty key (which drops legal forms), a key counts only when every payment under it names
  the owner exactly. The names apply to spending only (the overview, the budgets and the receipt loop),
  not to Finanzen, Zahlungen: from a business account a transfer to the owner is a private withdrawal
  for tax, which keeps its own answer there. Names are added and taken out one at a time on the stored
  list (row locked), so two open pages never undo each other. A limit that is the average of earlier
  months says "(Durchschnitt)" in the budget chart.
- **Klarna reconciliation (asked by the coordinator on 2026-10-23):** the payments tab compared each
  year's collections with the same year's purchases, so instalments and late-December purchases
  collected in January looked like money collected without a purchase (977.08 EUR for 2026 on
  production). It now carries what earlier years left open into the year and allows a pay-later
  service to be behind by the purchases of the last 60 days of its list. Checked read-only against
  production: 2,721.83 EUR carried in, the running balance closes to 15 cents at the end of August 2026.
  The scripts that export Klarna's list and the run of 2026-10-23 are in
  `docs/operations/klarna-export.md`.

Verified in a local browser on invented data: overview and phone width (no sideways scroll of the
page), adding a name moves its payments out of the totals and the open receipt count (120 to 100),
the name and the tab survive a reload.
